//! Local, isolated Audiveris jobs. Keep the complete book and engine output for
//! correction; a successful subprocess exit alone is not proof of a usable score.
mod layout;
mod musicxml;
mod project;
mod runtime;
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeSet, HashMap},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Seek, SeekFrom, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::Manager;

const RECOGNITION_REVISION: u32 = 4;
const XML_LIMIT: u64 = 64 * 1024 * 1024;
const TIMEOUT: Duration = Duration::from_secs(2 * 60 * 60);

#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
#[serde(default)]
pub struct Options {
    recover_beam_borders: bool,
    dpi: u16,
    first_page: u32,
    last_page: Option<u32>,
    lyrics: bool,
    languages: String,
    tessdata_path: String,
    lyrics_above: bool,
    small_notes: bool,
    tremolos: bool,
    fingerings: bool,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            recover_beam_borders: false,
            dpi: 400,
            first_page: 1,
            last_page: None,
            lyrics: true,
            languages: "eng".into(),
            tessdata_path: String::new(),
            lyrics_above: false,
            small_notes: false,
            tremolos: true,
            fingerings: false,
        }
    }
}
impl Options {
    fn validate(&self) -> Result<(), String> {
        if self.languages.len() > 100
            || !self
                .languages
                .split('+')
                .all(|code| code.len() == 3 && code.bytes().all(|b| b.is_ascii_lowercase()))
        {
            return Err("Enter OCR language codes such as eng, deu or deu+eng".into());
        }
        if ![300, 400].contains(&self.dpi)
            || self.first_page == 0
            || self.first_page > 100_000
            || self
                .last_page
                .is_some_and(|p| p < self.first_page || p > 100_000)
        {
            return Err("Choose 300 or 400 DPI and a valid page range".into());
        }
        // Audiveris needs a finite upper bound for a non-default start page.
        if self.first_page != 1 && self.last_page.is_none() {
            return Err("Set the last page when starting after page 1".into());
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Artifact {
    name: String,
    kind: String,
    review: Option<musicxml::Review>,
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct Progress {
    phase: String,
    current_page: Option<u32>,
    total_pages: Option<u32>,
    completed_pages: u32,
    step: String,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct Job {
    #[serde(default)]
    recognition_revision: u32,
    id: String,
    score_id: String,
    status: String,
    created_at: u64,
    options: Options,
    source: String,
    engine: String,
    artifacts: Vec<Artifact>,
    warnings: Vec<String>,
    error: Option<String>,
    #[serde(default)]
    log_tail: String,
    #[serde(default)]
    progress: Option<Progress>,
}
struct Active {
    job: Mutex<Job>,
    cancel: AtomicBool,
}
#[derive(Default)]
pub struct OmrState {
    active: Mutex<Option<Arc<Active>>>,
    worker: Mutex<Option<std::thread::JoinHandle<()>>>,
    preparing: AtomicBool,
}

fn automatic_options(context: &str) -> Options {
    let text = context.to_lowercase();
    let mut languages = vec!["eng", "ita"];
    let groups: &[(&[&str], &str)] = &[
        (
            &[
                "german",
                "germany",
                "austria",
                "bach",
                "schumann",
                "schubert",
                "brahms",
                "beethoven",
                "wolf",
                "mahler",
            ],
            "deu",
        ),
        (
            &[
                "french", "france", "debussy", "ravel", "fauré", "faure", "poulenc", "berlioz",
            ],
            "fra",
        ),
        (
            &[
                "russian", "russia", "rachman", "tchaikov", "mussorg", "rimsky",
            ],
            "rus",
        ),
        (
            &["czech", "czechia", "dvořák", "dvorak", "janáček", "janacek"],
            "ces",
        ),
        (&["spanish", "spain", "granados", "falla"], "spa"),
        (&["polish", "poland", "chopin", "szymanowski"], "pol"),
        (
            &[
                "requiem",
                "missa",
                "mass",
                "magnificat",
                "stabat",
                "ave maria",
                "latin",
                "motet",
            ],
            "lat",
        ),
    ];
    for (hints, language) in groups {
        if hints.iter().any(|hint| text.contains(hint)) {
            languages.push(language);
        }
    }
    if languages.len() == 2 {
        languages.extend(["deu", "fra", "lat"]);
    }
    languages.sort_unstable();
    languages.dedup();
    // Unknown scores retain lyrics. Explicit instrumental metadata disables
    // lyric searches unless a vocal part is named in the same context.
    let words: Vec<_> = text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let contains = |hints: &[&str]| hints.iter().any(|hint| words.contains(hint));
    let vocal = contains(&[
        "voice", "voices", "vocal", "choir", "choral", "chorus", "song", "songs", "lied", "lieder",
        "opera", "oratorio", "cantata", "requiem", "missa", "mass", "motet", "aria", "lyrics",
        "soprano", "tenor", "baritone",
    ]);
    let instrumental = contains(&[
        "piano",
        "violin",
        "viola",
        "cello",
        "violoncello",
        "flute",
        "oboe",
        "clarinet",
        "bassoon",
        "horn",
        "trumpet",
        "trombone",
        "orchestra",
        "orchestral",
        "symphony",
        "quartet",
        "quintet",
        "sonata",
        "concerto",
        "étude",
        "etude",
        "study",
        "studies",
    ]);
    Options {
        recover_beam_borders: true,
        lyrics: vocal || !instrumental,
        languages: languages.join("+"),
        small_notes: ["cue notes", "small notes", "cadenza", "grace notes"]
            .iter()
            .any(|hint| text.contains(hint)),
        fingerings: ["piano", "étude", "etude", "study", "studies"]
            .iter()
            .any(|hint| text.contains(hint)),
        ..Options::default()
    }
}

#[tauri::command]
pub async fn start_automatic_omr(
    app: tauri::AppHandle,
    state: tauri::State<'_, OmrState>,
    score_id: String,
    input_path: Option<String>,
    context: String,
) -> Result<Job, String> {
    let base = root(&app)?;
    if state.preparing.swap(true, Ordering::SeqCst) {
        return Err("Local recognition is already being prepared. Please wait a moment.".into());
    }
    struct ResetPreparing<'a>(&'a AtomicBool);
    impl Drop for ResetPreparing<'_> {
        fn drop(&mut self) {
            self.0.store(false, Ordering::SeqCst);
        }
    }
    let reset = ResetPreparing(&state.preparing);
    let mut options = automatic_options(&context);
    let prepared = runtime::prepare(&base, &options.languages).await;
    drop(reset);
    let (engine, data) = prepared?;
    options.tessdata_path = data.to_string_lossy().into_owned();
    start_omr(
        app,
        state,
        score_id,
        input_path,
        Some(engine.to_string_lossy().into_owned()),
        options,
    )
    .await
}

impl OmrState {
    pub fn shutdown(&self) {
        if let Ok(slot) = self.active.lock() {
            if let Some(active) = slot.as_ref() {
                active.cancel.store(true, Ordering::Relaxed);
            }
        }
        if let Ok(mut worker) = self.worker.lock() {
            if let Some(worker) = worker.take() {
                let _ = worker.join();
            }
        }
    }
}

fn root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(app
        .path()
        .app_data_dir()
        .map_err(|e| e.to_string())?
        .join("omr"))
}
fn job_dir(root: &Path, id: &str) -> Result<PathBuf, String> {
    if id.is_empty() || !id.bytes().all(|b| b.is_ascii_digit() || b == b'-') {
        return Err("Invalid OMR job id".into());
    }
    Ok(root.join(id))
}
fn persist(dir: &Path, job: &Job) -> Result<(), String> {
    let bytes = serde_json::to_vec_pretty(job).map_err(|e| e.to_string())?;
    fs::write(dir.join("job.json.tmp"), bytes).map_err(|e| e.to_string())?;
    fs::rename(dir.join("job.json.tmp"), dir.join("job.json")).map_err(|e| e.to_string())
}
fn load(dir: &Path) -> Result<Job, String> {
    let mut job: Job =
        serde_json::from_reader(File::open(dir.join("job.json")).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    if job.status == "running" {
        job.status = "interrupted".into();
        job.error = Some("Sonora closed during recognition. Start a new conversion; this job's source and logs are retained.".into());
    }
    Ok(job)
}
fn tail(path: &Path) -> String {
    let Ok(mut file) = File::open(path) else {
        return String::new();
    };
    let len = file.metadata().map(|m| m.len()).unwrap_or(0);
    let _ = file.seek(SeekFrom::Start(len.saturating_sub(12 * 1024)));
    let mut bytes = Vec::new();
    let _ = file.take(12 * 1024).read_to_end(&mut bytes);
    String::from_utf8_lossy(&bytes).into_owned()
}

/// Audiveris can exit successfully with OCR entirely disabled. Require all
/// requested dictionaries up front, even for instrumental tempo/technique text.
fn ocr_folder(options: &Options) -> Result<PathBuf, String> {
    let mut folders = Vec::new();
    if !options.tessdata_path.trim().is_empty() {
        folders.push(PathBuf::from(&options.tessdata_path));
    } else if let Some(path) = std::env::var_os("TESSDATA_PREFIX") {
        folders.push(PathBuf::from(path));
    } else {
        if let Some(config) = std::env::var_os("XDG_CONFIG_HOME") {
            folders.push(PathBuf::from(config).join("AudiverisLtd/audiveris/tessdata"));
        }
        if let Some(home) = std::env::var_os("HOME") {
            let home = PathBuf::from(home);
            folders.push(home.join(".config/AudiverisLtd/audiveris/tessdata"));
            folders.push(home.join("Library/Application Support/AudiverisLtd/audiveris/tessdata"));
        }
        if let Some(config) = std::env::var_os("APPDATA") {
            folders.push(PathBuf::from(config).join("AudiverisLtd/audiveris/tessdata"));
        }
        folders.extend(
            [
                "/usr/share/tessdata",
                "/usr/share/tesseract-ocr/5/tessdata",
                "/usr/local/share/tessdata",
                "/opt/homebrew/share/tessdata",
            ]
            .map(PathBuf::from),
        );
    }
    folders.into_iter().find(|folder| options.languages.split('+').all(|code| {
        legacy_ocr_data(&folder.join(format!("{code}.traineddata")))
    })).ok_or_else(|| format!("Legacy-compatible OCR data for '{}' is missing. Install these languages using Audiveris Tools → Languages, or choose a tessdata folder from tesseract-ocr/tessdata. Audiveris 5.11 cannot use LSTM-only tessdata_fast or tessdata_best files. Recognition was not started.", options.languages))
}

/// Tesseract's traineddata directory is an entry count followed by int64 offsets.
/// Audiveris 5.11 uses OEM_TESSERACT_ONLY and needs unicharset (1) and inttemp (3).
/// Checking this small header avoids a full recognition run with incompatible data.
fn legacy_ocr_data(path: &Path) -> bool {
    let Ok(mut file) = File::open(path) else {
        return false;
    };
    let Ok(metadata) = file.metadata() else {
        return false;
    };
    let mut count = [0; 4];
    if file.read_exact(&mut count).is_err() {
        return false;
    }
    let little = (4..=1000).contains(&u32::from_le_bytes(count));
    let count = if little {
        u32::from_le_bytes(count)
    } else {
        u32::from_be_bytes(count)
    };
    if !(4..=1000).contains(&count) {
        return false;
    }
    let mut offsets = vec![0; count as usize * 8];
    if file.read_exact(&mut offsets).is_err() {
        return false;
    }
    [1usize, 3].iter().all(|index| {
        let bytes: [u8; 8] = offsets[index * 8..index * 8 + 8].try_into().unwrap();
        let offset = if little {
            i64::from_le_bytes(bytes)
        } else {
            i64::from_be_bytes(bytes)
        };
        offset >= 4 + count as i64 * 8 && (offset as u64) < metadata.len()
    })
}

fn diagnostics(dir: &Path, artifacts: &[Artifact], options: &Options) -> Vec<String> {
    let mut warnings = Vec::new();
    for artifact in artifacts.iter().filter(|a| a.kind == "project") {
        match project::inspect(
            &dir.join(&artifact.name),
            options.first_page,
            options.last_page,
        ) {
            Ok(issues) => warnings.extend(issues),
            Err(error) => warnings.push(format!("Could not verify source-page coverage: {error}")),
        }
    }
    if !artifacts.iter().any(|a| a.kind == "project") {
        warnings.push(
            "No editable Audiveris project was saved; source-page coverage could not be checked."
                .into(),
        );
    }
    if let Ok(file) = File::open(dir.join("engine.log")) {
        let mut seen = std::collections::HashSet::new();
        for line in BufReader::new(file.take(32 * 1024 * 1024))
            .lines()
            .map_while(Result::ok)
        {
            if line.starts_with("WARN ")
                || line.starts_with("ERROR ")
                || line.contains("no correct rhythm")
            {
                let message = line
                    .split_once('|')
                    .map(|(_, s)| s.trim())
                    .unwrap_or(line.as_str())
                    .to_string();
                if seen.insert(message.clone()) {
                    warnings.push(message);
                }
                if seen.len() >= 100 {
                    warnings.push(
                        "Additional engine warnings are available in the recognition log.".into(),
                    );
                    break;
                }
            }
        }
    }
    warnings
}

/// Pass original documents to the engine, not viewer thumbnails or JPEG renders.
fn arguments(input: &Path, output: &Path, options: &Options) -> Vec<String> {
    let mut args = vec![
        "-batch".into(),
        "-transcribe".into(),
        "-export".into(),
        // -swap checkpoints each processed page. -save would rewrite the
        // whole project after every internal recognition step.
        "-swap".into(),
        "-output".into(),
        output.to_string_lossy().into_owned(),
    ];
    let mut constants = HashMap::from([
        (
            "org.audiveris.omr.image.ImageLoading.pdfResolution",
            options.dpi.to_string(),
        ),
        (
            "org.audiveris.omr.sheet.BookManager.useCompression",
            "false".into(),
        ),
        // A partially read key can leave the time signature beyond the stock
        // four-interline search window. Recognize it before HEADS mistakes its
        // digits for notes; retain the engine's geometric and grade checks.
        (
            "org.audiveris.omr.sheet.time.TimeBuilder.roiWidth",
            "6.0".into(),
        ),
        (
            "org.audiveris.omr.sheet.time.TimeBuilder.maxEvalRank",
            "8".into(),
        ),
        (
            "org.audiveris.omr.sheet.key.KeyExtractor.maxEvalRank",
            "8".into(),
        ),
        // Recover partially fused beam/hook edges. Audiveris still checks ink
        // density, beam thickness and stem links before accepting a candidate.
        (
            "org.audiveris.omr.sheet.beam.BeamStructure.allowBorderCreation",
            options.recover_beam_borders.to_string(),
        ),
        // Classical grand staves can have braces without connected internal
        // barlines (notably cadenzas). Keep the hands in a single logical part.
        (
            "org.audiveris.omr.sheet.ProcessingSwitches.disconnectedBracedParts",
            "true".into(),
        ),
        (
            "org.audiveris.omr.sheet.ProcessingSwitches.keepGrayImages",
            "true".into(),
        ),
        (
            "org.audiveris.omr.text.Language.defaultSpecification",
            options.languages.clone(),
        ),
        (
            "org.audiveris.omr.sheet.ProcessingSwitches.lyrics",
            options.lyrics.to_string(),
        ),
        (
            "org.audiveris.omr.sheet.ProcessingSwitches.lyricsAboveStaff",
            options.lyrics_above.to_string(),
        ),
        (
            "org.audiveris.omr.sheet.ProcessingSwitches.smallHeads",
            options.small_notes.to_string(),
        ),
        (
            "org.audiveris.omr.sheet.ProcessingSwitches.smallBeams",
            options.small_notes.to_string(),
        ),
        (
            "org.audiveris.omr.sheet.ProcessingSwitches.tremolos",
            options.tremolos.to_string(),
        ),
        (
            "org.audiveris.omr.sheet.ProcessingSwitches.fingerings",
            options.fingerings.to_string(),
        ),
        (
            "org.audiveris.omr.sheet.ProcessingSwitches.articulations",
            "true".into(),
        ),
        (
            "org.audiveris.omr.sheet.ProcessingSwitches.dynamicsAboveStaff",
            "true".into(),
        ),
        (
            "org.audiveris.omr.sheet.ProcessingSwitches.dynamicsBelowStaff",
            "true".into(),
        ),
    ])
    .drain()
    .map(|(key, value)| format!("{key}={value}"))
    .collect::<Vec<_>>();
    constants.sort();
    for constant in constants {
        args.extend(["-constant".into(), constant]);
    }
    if let Some(last) = options.last_page {
        args.extend(["-sheets".into(), format!("{}-{last}", options.first_page)]);
    }
    args.extend(["--".into(), input.to_string_lossy().into_owned()]);
    args
}

fn collect(
    dir: &Path,
    base: &Path,
    depth: usize,
    artifacts: &mut Vec<Artifact>,
    warnings: &mut Vec<String>,
) -> Result<(), String> {
    if depth > 8 {
        return Err("Unexpectedly deep engine output directory".into());
    }
    for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ty = entry.file_type().map_err(|e| e.to_string())?;
        if ty.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ty.is_dir() {
            collect(&path, base, depth + 1, artifacts, warnings)?;
        } else if ty.is_file() {
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let kind = match ext {
                "xml" | "musicxml" => "musicxml",
                "omr" => "project",
                _ => continue,
            };
            if artifacts.len() >= 1000 {
                return Err("Too many OMR artifacts".into());
            }
            let name = path
                .strip_prefix(base)
                .map_err(|e| e.to_string())?
                .to_string_lossy()
                .into_owned();
            let review = if kind == "musicxml" {
                if path.metadata().map_err(|e| e.to_string())?.len() > XML_LIMIT {
                    warnings.push(format!("{name}: too large for automatic review"));
                    None
                } else {
                    match musicxml::inspect(&fs::read(&path).map_err(|e| e.to_string())?) {
                        Ok(review) => Some(review),
                        Err(error) => {
                            warnings.push(format!("{name}: {error}"));
                            None
                        }
                    }
                }
            } else {
                None
            };
            artifacts.push(Artifact {
                name,
                kind: kind.into(),
                review,
            });
        }
    }
    Ok(())
}

fn observe_progress(progress: &mut Progress, line: &str, completed: &mut BTreeSet<u32>) {
    if line.contains("PartwiseBuilder") && line.contains("Exporting sheet(s)") {
        progress.phase = "exporting".into();
        progress.current_page = None;
    }
    if let Some((_, rest)) = line.split_once("| ") {
        if let Some((prefix, _)) = rest.split_once(" sheets in ") {
            if let Some(total) = prefix
                .split_whitespace()
                .last()
                .and_then(|n| n.parse::<u32>().ok())
            {
                progress.total_pages = Some(total);
            }
        }
        if let Some((_, rest)) = rest.split_once("End of Stub#") {
            if let Ok(page) = rest.trim().parse::<u32>() {
                completed.insert(page);
                progress.completed_pages = progress.completed_pages.max(completed.len() as u32);
            }
        }
        if line.contains("StepMonitoring") {
            if let Some((_, page)) = line.split_once('#') {
                progress.current_page = page.split(']').next().and_then(|n| n.parse().ok());
            }
            progress.step = rest.trim().to_string();
        }
    }
}

fn run(
    dir: &Path,
    active: &Active,
    engine: &str,
    input: &Path,
    options: &Options,
) -> Result<bool, String> {
    let start = Instant::now();
    let output = dir.join("output");
    fs::create_dir_all(&output).map_err(|e| e.to_string())?;
    let mut source = input.to_path_buf();
    let project_input = input.extension().is_some_and(|e| e == "omr");
    let mut recovering = project_input
        && project::pages(input)
            .map(|(total, pages)| pages.len() < total as usize)
            .unwrap_or(true);
    if !project_input {
        let mut args = arguments(input, &output, options);
        args.retain(|a| a != "-transcribe" && a != "-export");
        args.splice(1..1, ["-step".into(), "PAGE".into()]);
        set_phase(active, "recognizing");
        let success = run_command(dir, active, engine, options, args, start, "recognition")?;
        source = find_project(&output)
            .ok_or("Recognition did not save a score project. Review the conversion log.")?;
        if !success {
            let log = fs::read_to_string(dir.join("engine.log")).unwrap_or_default();
            if !metronome_failure(&log) {
                return Ok(false);
            }
            recovering = true;
        }
    }
    // Never reopen the original failed job: only normalize this job's private
    // project copy. MusicXML and image data pass through without alteration.
    set_phase(
        active,
        if recovering {
            "recovering"
        } else {
            "checking_layout"
        },
    );
    if let Ok((total, completed)) = project::pages(&source) {
        let mut job = active.job.lock().unwrap();
        let progress = job.progress.get_or_insert_with(Progress::default);
        progress.total_pages = Some(total);
        progress.completed_pages = completed.len() as u32;
    }
    project::make_compatible(&source)?;
    let mut args = arguments(&source, &output, options);
    if recovering {
        set_phase(active, "recovering");
        args.retain(|a| a != "-transcribe" && a != "-export");
        args.splice(1..1, ["-step".into(), "PAGE".into()]);
        // Audiveris 5.11 can return fewer classifier candidates than its
        // metronome loop expects. Limit only the recovery attempt to top one.
        args.splice(
            1..1,
            [
                "-constant".into(),
                "org.audiveris.omr.sig.inter.MetronomeInter.maxEvaluationRank=1".into(),
            ],
        );
        if !run_command(dir, active, engine, options, args, start, "recovery")? {
            return Ok(false);
        }
        // Retried pages can contain more empty glyphs. Normalize after saving
        // them too, before the separate exporter reloads the book.
        project::make_compatible(&source)?;
    }
    set_phase(active, "checking_layout");
    if layout::needs_repair(&source) {
        fs::copy(&source, dir.join("recognition-original.omr")).map_err(|e| e.to_string())?;
        match layout::reconcile(&source) {
            Ok(report) => {
                fs::write(
                    dir.join("layout-report.json"),
                    serde_json::to_vec_pretty(&report).unwrap(),
                )
                .map_err(|e| e.to_string())?;
                if report.systems_rejoined > 0 {
                    active.job.lock().unwrap().warnings.push(format!("Layout consistency: rejoined {} isolated grand-staff split(s) on source pages {:?}. Both staves and their notation were retained.",report.systems_rejoined,report.source_pages));
                }
            }
            Err(error) => active.job.lock().unwrap().warnings.push(format!(
                "Score structure needs review: {error}. The original recognition project was kept."
            )),
        }
    }
    set_phase(active, "exporting");
    let mut args = arguments(&source, &output, options);
    args.retain(|a| a != "-transcribe");
    run_command(dir, active, engine, options, args, start, "export")
}

fn metronome_failure(log: &str) -> bool {
    log.contains("MetronomeInter.recognizeNote") && log.contains("IndexOutOfBoundsException")
}

fn find_project(dir: &Path) -> Option<PathBuf> {
    fs::read_dir(dir)
        .ok()?
        .flatten()
        .map(|e| e.path())
        .find(|p| p.extension().is_some_and(|e| e == "omr"))
}

fn set_phase(active: &Active, phase: &str) {
    let mut job = active.job.lock().unwrap();
    let progress = job.progress.get_or_insert_with(Progress::default);
    progress.phase = phase.into();
    progress.current_page = None;
    progress.step.clear();
}

fn run_command(
    dir: &Path,
    active: &Active,
    engine: &str,
    options: &Options,
    args: Vec<String>,
    start: Instant,
    phase: &str,
) -> Result<bool, String> {
    if active.cancel.load(Ordering::Relaxed) {
        return Err("Conversion cancelled. Partial output is retained.".into());
    }
    let mut log = OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("engine.log"))
        .map_err(|e| e.to_string())?;
    writeln!(log, "\nSonora: {phase}").map_err(|e| e.to_string())?;
    fs::write(
        dir.join(format!("arguments-{phase}.json")),
        serde_json::to_vec_pretty(&args).unwrap(),
    )
    .map_err(|e| e.to_string())?;
    let initial_offset = log.metadata().map_err(|e| e.to_string())?.len();
    let mut command = if engine.ends_with(".jar") {
        let mut command = Command::new("java");
        command.args(["-jar", engine]);
        command
    } else {
        Command::new(engine)
    };
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command
        .args(args)
        .env("TESSDATA_PREFIX", ocr_folder(options)?)
        .stdin(Stdio::null())
        .stdout(Stdio::from(log.try_clone().map_err(|e| e.to_string())?))
        .stderr(Stdio::from(log))
        .spawn()
        .map_err(|e| {
            format!(
                "Could not start Audiveris: {e}. Install Audiveris 5.11 or choose its launcher."
            )
        })?;
    let mut observed = BTreeSet::new();
    let mut offset = initial_offset;
    loop {
        // Read only newly appended complete lines: large orchestral logs must
        // not be reread on every UI update.
        if let Ok(file) = File::open(dir.join("engine.log")) {
            let mut reader = BufReader::new(file);
            if reader.seek(SeekFrom::Start(offset)).is_ok() {
                loop {
                    let mut line = String::new();
                    let Ok(n) = reader.read_line(&mut line) else {
                        break;
                    };
                    if n == 0 || !line.ends_with('\n') {
                        break;
                    }
                    offset += n as u64;
                    let mut job = active.job.lock().unwrap();
                    let progress = job.progress.get_or_insert_with(Progress::default);
                    observe_progress(progress, &line, &mut observed);
                }
            }
        }
        if active.cancel.load(Ordering::Relaxed) || start.elapsed() > TIMEOUT {
            stop_child(&mut child);
            return Err(if active.cancel.load(Ordering::Relaxed) {
                "Conversion cancelled. Partial output is retained."
            } else {
                "Conversion exceeded two hours. Try a shorter page range."
            }
            .into());
        }
        match child.try_wait() {
            Ok(Some(status)) => return Ok(status.success()),
            Ok(None) => std::thread::sleep(Duration::from_millis(250)),
            Err(e) => {
                stop_child(&mut child);
                return Err(e.to_string());
            }
        }
    }
}

fn stop_child(child: &mut std::process::Child) {
    #[cfg(unix)]
    // The child was launched in its own process group. Kill the group so a shell
    // launcher cannot leave its Java subprocess running after cancellation/exit.
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    let _ = child.kill();
    let _ = child.wait();
}

#[tauri::command]
pub async fn pick_omr_engine() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Choose Audiveris launcher (bin/Audiveris, Audiveris.exe, .bat or .jar)")
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn pick_omr_tessdata() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Choose tessdata folder containing OCR .traineddata files")
        .pick_folder()
        .await
        .map(|file| file.path().to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn pick_omr_input() -> Option<String> {
    rfd::AsyncFileDialog::new()
        .set_title("Choose a score PDF or photo")
        .add_filter("Scores", &["pdf", "png", "jpg", "jpeg", "tif", "tiff"])
        .pick_file()
        .await
        .map(|file| file.path().to_string_lossy().into_owned())
}

#[tauri::command]
pub async fn cache_omr_pdf(
    app: tauri::AppHandle,
    request: tauri::ipc::Request<'_>,
) -> Result<String, String> {
    let bytes = match request.body() {
        tauri::ipc::InvokeBody::Raw(bytes)
            if bytes.starts_with(b"%PDF-") && bytes.len() <= 256 * 1024 * 1024 =>
        {
            bytes.clone()
        }
        _ => return Err("Choose a PDF smaller than 256 MB".into()),
    };
    let folder = root(&app)?.join("imports");
    tokio::task::spawn_blocking(move || {
        fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
        let path = folder.join(format!(
            "score-{}.pdf",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok(path.to_string_lossy().into_owned())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Explicit, one-time setup. Score conversion itself never downloads anything.
#[tauri::command]
pub async fn install_omr_languages(
    app: tauri::AppHandle,
    languages: String,
) -> Result<String, String> {
    Options {
        languages: languages.clone(),
        ..Options::default()
    }
    .validate()?;
    let folder = root(&app)?.join("tessdata");
    fs::create_dir_all(&folder).map_err(|e| e.to_string())?;
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(180))
        .user_agent("Sonora local OCR setup")
        .build()
        .map_err(|e| e.to_string())?;
    for code in languages.split('+') {
        let target = folder.join(format!("{code}.traineddata"));
        if legacy_ocr_data(&target) {
            continue;
        }
        let mut response = client
            .get(format!(
                "https://raw.githubusercontent.com/tesseract-ocr/tessdata/4.1.0/{code}.traineddata"
            ))
            .send()
            .await
            .map_err(|e| format!("Could not download {code} OCR data: {e}"))?
            .error_for_status()
            .map_err(|e| format!("OCR language {code} is unavailable: {e}"))?;
        let temporary = folder.join(format!(
            "{code}-{}.tmp",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_nanos()
        ));
        let result = async {
            use std::io::Write;
            let mut file = File::create(&temporary).map_err(|e| e.to_string())?;
            let mut size = 0usize;
            while let Some(chunk) = response.chunk().await.map_err(|e| e.to_string())? {
                size += chunk.len();
                if size > 100 * 1024 * 1024 {
                    return Err("OCR dictionary exceeds download size limit".to_string());
                }
                file.write_all(&chunk).map_err(|e| e.to_string())?;
            }
            drop(file);
            if !legacy_ocr_data(&temporary) {
                return Err(format!(
                    "Downloaded {code} data is not compatible with Audiveris 5.11"
                ));
            }
            fs::rename(&temporary, &target).map_err(|e| e.to_string())
        }
        .await;
        if let Err(error) = result {
            let _ = fs::remove_file(&temporary);
            return Err(error);
        }
    }
    Ok(folder.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn list_omr(
    app: tauri::AppHandle,
    state: tauri::State<'_, OmrState>,
) -> Result<Vec<Job>, String> {
    let active = state
        .active
        .lock()
        .map_err(|e| e.to_string())?
        .as_ref()
        .map(|a| a.job.lock().map(|j| j.clone()).map_err(|e| e.to_string()))
        .transpose()?;
    let mut jobs = Vec::new();
    let root = root(&app)?;
    if root.is_dir() {
        for entry in fs::read_dir(root).map_err(|e| e.to_string())?.flatten() {
            if entry.file_type().is_ok_and(|t| t.is_dir()) {
                if let Ok(job) = load(&entry.path()) {
                    if active.as_ref().is_none_or(|a| a.id != job.id) {
                        jobs.push(job);
                    }
                }
            }
        }
    }
    if let Some(job) = active {
        jobs.push(job);
    }
    jobs.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    jobs.truncate(100);
    Ok(jobs)
}

#[tauri::command]
pub async fn read_omr_artifact(
    app: tauri::AppHandle,
    state: tauri::State<'_, OmrState>,
    id: String,
    index: usize,
) -> Result<String, String> {
    let job = omr_status(app.clone(), state, id.clone())?;
    if job.status == "running" {
        return Err("Recognition is still running".into());
    }
    let artifact = job
        .artifacts
        .get(index)
        .filter(|a| a.kind == "musicxml")
        .ok_or("Choose a MusicXML movement")?;
    let source = artifact_path(&job_dir(&root(&app)?, &id)?, &artifact.name)?;
    tokio::task::spawn_blocking(move || {
        let file = File::open(source).map_err(|e| e.to_string())?;
        let mut bytes = Vec::new();
        file.take(XML_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        if bytes.len() as u64 > XML_LIMIT {
            return Err("MusicXML exceeds the 64 MB size limit".into());
        }
        String::from_utf8(bytes).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

// Reuse only byte-identical input and identical recognition settings. The
// source file can have changed since an earlier conversion failed.
fn same_file(a: &Path, b: &Path) -> bool {
    let Ok(mut a) = File::open(a) else {
        return false;
    };
    let Ok(mut b) = File::open(b) else {
        return false;
    };
    if a.metadata().ok().map(|m| m.len()) != b.metadata().ok().map(|m| m.len()) {
        return false;
    }
    let mut aa = [0; 65536];
    let mut bb = [0; 65536];
    loop {
        let (Ok(na), Ok(nb)) = (a.read(&mut aa), b.read(&mut bb)) else {
            return false;
        };
        if na != nb || aa[..na] != bb[..nb] {
            return false;
        }
        if na == 0 {
            return true;
        }
    }
}

fn resumable_project(
    root: &Path,
    current: &Path,
    score: &str,
    snapshot: &Path,
    options: &Options,
) -> Option<PathBuf> {
    let mut candidates = Vec::new();
    for entry in fs::read_dir(root).ok()?.flatten() {
        if entry.path() == current {
            continue;
        }
        let Ok(job) = load(&entry.path()) else {
            continue;
        };
        let repair_completed = job.status == "complete"
            && job.recognition_revision >= 2
            && job.recognition_revision <= RECOGNITION_REVISION;
        if (!repair_completed && job.recognition_revision != RECOGNITION_REVISION)
            || job.score_id != score
            || job.options != *options
            || (!repair_completed && !["failed", "interrupted"].contains(&job.status.as_str()))
        {
            continue;
        }
        // Interrupted recognition resumes only for the known classifier crash.
        // Completed books are reused only for a verified structural repair.
        if !repair_completed
            && !metronome_failure(
                &fs::read_to_string(entry.path().join("engine.log")).unwrap_or_default(),
            )
        {
            continue;
        }
        let Some(name) = Path::new(&job.source).file_name() else {
            continue;
        };
        if !same_file(snapshot, &entry.path().join("input").join(name)) {
            continue;
        }
        if let Some(project) = find_project(&entry.path().join("output")) {
            if !repair_completed || layout::needs_repair(&project) {
                candidates.push((job.created_at, project));
            }
        }
    }
    candidates
        .into_iter()
        .max_by_key(|(stamp, _)| *stamp)
        .map(|(_, path)| path)
}

#[tauri::command]
pub async fn start_omr(
    app: tauri::AppHandle,
    state: tauri::State<'_, OmrState>,
    score_id: String,
    input_path: Option<String>,
    engine_path: Option<String>,
    mut options: Options,
) -> Result<Job, String> {
    options.validate()?;
    options.tessdata_path = ocr_folder(&options)?
        .canonicalize()
        .map_err(|e| e.to_string())?
        .to_string_lossy()
        .into_owned();
    let input = match input_path.filter(|p| !p.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => rfd::AsyncFileDialog::new()
            .set_title("Choose the original score PDF or photo")
            .add_filter("Scores", &["pdf", "png", "jpg", "jpeg", "tif", "tiff"])
            .pick_file()
            .await
            .ok_or("No input selected")?
            .path()
            .to_path_buf(),
    };
    let input = input.canonicalize().map_err(|e| e.to_string())?;
    let ext = input
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !["pdf", "png", "jpg", "jpeg", "tif", "tiff"].contains(&ext.as_str()) || !input.is_file() {
        return Err("Choose a PDF, PNG, JPEG or TIFF score".into());
    }
    let engine = engine_path
        .filter(|p| !p.trim().is_empty())
        .or_else(|| std::env::var("SONORA_AUDIVERIS").ok())
        .unwrap_or_else(|| {
            let mut candidates = vec![
                PathBuf::from("/opt/audiveris/bin/Audiveris"),
                PathBuf::from("/Applications/Audiveris.app/Contents/MacOS/Audiveris"),
            ];
            if let Some(root) = std::env::var_os("PROGRAMFILES") {
                candidates.push(PathBuf::from(root).join("Audiveris/Audiveris.exe"));
            }
            candidates
                .into_iter()
                .find(|p| p.is_file())
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_else(|| "Audiveris".into())
        });
    let mut slot = state.active.lock().map_err(|e| e.to_string())?;
    if slot
        .as_ref()
        .is_some_and(|a| a.job.lock().map(|j| j.status == "running").unwrap_or(true))
    {
        return Err("A score is already being recognized. Wait for it or cancel it first.".into());
    }
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default();
    let id = format!("{}-{}", stamp.as_nanos(), std::process::id());
    let dir = job_dir(&root(&app)?, &id)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let job = Job {
        recognition_revision: RECOGNITION_REVISION,
        id,
        score_id,
        status: "running".into(),
        created_at: stamp.as_millis() as u64,
        options: options.clone(),
        source: input.to_string_lossy().into_owned(),
        engine: engine.clone(),
        artifacts: Vec::new(),
        warnings: Vec::new(),
        error: None,
        log_tail: String::new(),
        progress: None,
    };
    persist(&dir, &job)?;
    let active = Arc::new(Active {
        job: Mutex::new(job.clone()),
        cancel: AtomicBool::new(false),
    });
    let worker = active.clone();
    let history_root = root(&app)?;
    let handle = std::thread::Builder::new().name("sonora-omr".into()).spawn(move || {
        // A private snapshot prevents original-file edits from changing a running job.
        let source_dir = dir.join("input");
        let snapshot = source_dir.join(input.file_name().unwrap_or_else(|| std::ffi::OsStr::new("score")));
        let outcome = fs::create_dir_all(source_dir).map_err(|e| e.to_string())
            .and_then(|_| fs::copy(&input, &snapshot).map_err(|e| e.to_string()))
            .and_then(|_| {
                let saved = resumable_project(&history_root, &dir, &worker.job.lock().unwrap().score_id, &snapshot, &options);
                let source = if let Some(saved) = saved {
                    let complete = project::pages(&saved).is_ok_and(|(total,pages)| total as usize == pages.len());
                    set_phase(&worker, if complete { "checking_layout" } else { "recovering" });
                    fs::create_dir_all(dir.join("output")).map_err(|e| e.to_string())?;
                    let destination = dir.join("output").join(saved.file_name().ok_or("Missing project filename")?);
                    fs::copy(&saved, &destination).map_err(|e| e.to_string())?;
                    destination
                } else { snapshot.clone() };
                run(&dir, &worker, &engine, &source, &options)
            });
        let mut job = worker.job.lock().unwrap().clone();
        let mut artifacts = Vec::new();
        let mut warnings = job.warnings.clone();
        if dir.join("output").is_dir() {
            if let Err(error) = collect(&dir.join("output"), &dir, 0, &mut artifacts, &mut warnings) { warnings.push(error); }
        }
        artifacts.sort_by(|a,b| a.name.cmp(&b.name));
        warnings.extend(diagnostics(&dir, &artifacts, &options));
        let usable = artifacts.iter().any(|a| a.review.as_ref().is_some_and(|r| r.notes > 0));
        let ocr_failed = warnings.iter().any(|w| w.contains("Could not initialize TessBaseAPI") || w.contains("Missing support for") || w.contains("No installed OCR languages") || w.contains("Could not link Tesseract"));
        match outcome {
            Ok(success) if usable && !ocr_failed => {
                job.status = "complete".into();
                if !success { warnings.push("Audiveris exited with an error. Exports may be partial; inspect the log and project.".into()); }
            }
            Ok(_) => { job.status = "failed".into(); job.error = Some(if ocr_failed { "Audiveris could not recognize text. Check the OCR data and recognition log before using the partial exports." } else { "Audiveris did not produce a readable MusicXML score with notes. Review the log or try a different page range." }.into()); }
            Err(error) => {
                job.status = if worker.cancel.load(Ordering::Relaxed) { "cancelled" } else { "failed" }.into();
                job.error = Some(error);
            }
        }
        if let Some(progress) = job.progress.as_mut() {
            progress.phase = job.status.clone();
        }
        job.artifacts = artifacts;
        job.warnings = warnings;
        job.log_tail = tail(&dir.join("engine.log"));
        if let Err(error) = persist(&dir, &job) { job.warnings.push(format!("Could not save job history: {error}")); }
        *worker.job.lock().unwrap() = job;
    }).map_err(|e| e.to_string())?;
    *state.worker.lock().map_err(|e| e.to_string())? = Some(handle);
    *slot = Some(active);
    Ok(job)
}

#[tauri::command]
pub fn omr_status(
    app: tauri::AppHandle,
    state: tauri::State<'_, OmrState>,
    id: String,
) -> Result<Job, String> {
    let dir = job_dir(&root(&app)?, &id)?;
    if let Some(active) = state.active.lock().map_err(|e| e.to_string())?.as_ref() {
        let mut job = active.job.lock().map_err(|e| e.to_string())?.clone();
        if job.id == id {
            job.log_tail = tail(&dir.join("engine.log"));
            return Ok(job);
        }
    }
    let mut job = load(&dir)?;
    job.log_tail = tail(&dir.join("engine.log"));
    Ok(job)
}

#[tauri::command]
pub fn latest_omr(
    app: tauri::AppHandle,
    state: tauri::State<'_, OmrState>,
    score_id: String,
) -> Result<Option<Job>, String> {
    if let Some(active) = state.active.lock().map_err(|e| e.to_string())?.as_ref() {
        let job = active.job.lock().map_err(|e| e.to_string())?;
        if job.score_id == score_id {
            return Ok(Some(job.clone()));
        }
    }
    let mut latest: Option<Job> = None;
    let root = root(&app)?;
    if root.is_dir() {
        for entry in fs::read_dir(root).map_err(|e| e.to_string())?.flatten() {
            if entry.file_type().is_ok_and(|ty| ty.is_dir()) {
                if let Ok(job) = load(&entry.path()) {
                    if job.score_id == score_id
                        && latest
                            .as_ref()
                            .is_none_or(|old| job.created_at > old.created_at)
                    {
                        latest = Some(job);
                    }
                }
            }
        }
    }
    Ok(latest)
}

#[tauri::command]
pub fn cancel_omr(state: tauri::State<'_, OmrState>, id: String) -> Result<(), String> {
    if let Some(active) = state.active.lock().map_err(|e| e.to_string())?.as_ref() {
        if active.job.lock().map_err(|e| e.to_string())?.id == id {
            active.cancel.store(true, Ordering::Relaxed);
        }
    }
    Ok(())
}

fn artifact_path(dir: &Path, name: &str) -> Result<PathBuf, String> {
    if !Path::new(name)
        .components()
        .all(|c| matches!(c, Component::Normal(_)))
    {
        return Err("Invalid artifact path".into());
    }
    let path = dir.join(name).canonicalize().map_err(|e| e.to_string())?;
    if !path.starts_with(dir.canonicalize().map_err(|e| e.to_string())?) {
        return Err("Artifact is outside its job".into());
    }
    Ok(path)
}

#[tauri::command]
pub async fn save_omr_artifact(
    app: tauri::AppHandle,
    state: tauri::State<'_, OmrState>,
    id: String,
    index: usize,
) -> Result<bool, String> {
    let job = omr_status(app.clone(), state, id.clone())?;
    if job.status == "running" {
        return Err("Wait for recognition to finish before saving".into());
    }
    let artifact = job.artifacts.get(index).ok_or("Unknown OMR artifact")?;
    let source = artifact_path(&job_dir(&root(&app)?, &id)?, &artifact.name)?;
    let name = source.file_name().unwrap().to_string_lossy();
    let Some(target) = rfd::AsyncFileDialog::new()
        .set_file_name(name.as_ref())
        .save_file()
        .await
    else {
        return Ok(false);
    };
    let target = target.path().to_path_buf();
    if target == source || target.canonicalize().ok().as_ref() == Some(&source) {
        return Ok(true);
    }
    tokio::task::spawn_blocking(move || {
        fs::copy(source, target)
            .map(|_| true)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn command_preserves_full_book_and_recognition_features() {
        let options = Options {
            first_page: 2,
            last_page: Some(8),
            small_notes: true,
            ..Options::default()
        };
        options.validate().unwrap();
        let args = arguments(
            Path::new("/a score/@input.pdf"),
            Path::new("/output folder"),
            &options,
        );
        assert_eq!(args.last().unwrap(), "/a score/@input.pdf");
        assert_eq!(args[args.len() - 2], "--");
        assert!(!args.iter().any(|a| a == "-save"));
        for value in [
            "-swap",
            "-transcribe",
            "-export",
            "2-8",
            "org.audiveris.omr.image.ImageLoading.pdfResolution=400",
            "org.audiveris.omr.sheet.ProcessingSwitches.smallHeads=true",
            "org.audiveris.omr.sheet.ProcessingSwitches.tremolos=true",
            "org.audiveris.omr.sheet.ProcessingSwitches.disconnectedBracedParts=true",
            "org.audiveris.omr.sheet.time.TimeBuilder.roiWidth=6.0",
            "org.audiveris.omr.sheet.time.TimeBuilder.maxEvalRank=8",
            "org.audiveris.omr.sheet.key.KeyExtractor.maxEvalRank=8",
        ] {
            assert!(args.iter().any(|s| s == value), "{value}");
        }
    }

    #[test]
    fn automatic_profile_needs_no_user_settings() {
        let vocal = automatic_options("Robert Schumann Germany voice and piano");
        assert_eq!(vocal.languages, "deu+eng+ita");
        assert!(vocal.lyrics && vocal.tremolos && vocal.fingerings && vocal.recover_beam_borders);
        assert!(!vocal.small_notes);
        assert!(automatic_options("Chamber score with cue notes").small_notes);
        assert_eq!(
            (vocal.first_page, vocal.last_page, vocal.dpi),
            (1, None, 400)
        );
        assert!(automatic_options("Requiem").languages.contains("lat"));
        assert!(automatic_options("Rachmaninoff Russian song")
            .languages
            .contains("rus"));
        assert!(automatic_options("").languages.contains("fra"));
        assert!(!automatic_options("Beethoven piano sonata").lyrics);
        assert!(!automatic_options("String quartet").lyrics);
        assert!(automatic_options("Songs for voice and piano").lyrics);
        assert!(automatic_options("Choral symphony and orchestra").lyrics);
        assert!(automatic_options("").lyrics);
        // Substring matching would incorrectly classify Mussorgsky as a song.
        assert!(!automatic_options("Mussorgsky piano suite").lyrics);
    }
    #[test]
    fn rejects_bad_ranges_and_job_traversal() {
        assert!(Options {
            first_page: 0,
            ..Options::default()
        }
        .validate()
        .is_err());
        assert!(Options {
            first_page: 3,
            last_page: Some(2),
            ..Options::default()
        }
        .validate()
        .is_err());
        assert!(Options {
            dpi: 72,
            ..Options::default()
        }
        .validate()
        .is_err());
        assert!(job_dir(Path::new("/tmp"), "../other").is_err());
        assert!(artifact_path(Path::new("/tmp"), "../other").is_err());
    }

    fn temporary_dir() -> PathBuf {
        let dir = std::env::temp_dir().join(format!(
            "sonora-omr-test-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn missing_ocr_data_cannot_silently_drop_lyrics() {
        let dir = temporary_dir();
        let options = Options {
            tessdata_path: dir.display().to_string(),
            languages: "deu+eng".into(),
            ..Options::default()
        };
        assert!(ocr_folder(&options).is_err());
        fs::write(dir.join("eng.traineddata"), b"fixture").unwrap();
        assert!(ocr_folder(&options).is_err());
        let mut header = vec![0u8; 64];
        header[..4].copy_from_slice(&6u32.to_le_bytes());
        header[12..20].copy_from_slice(&52i64.to_le_bytes());
        header[28..36].copy_from_slice(&60i64.to_le_bytes());
        fs::write(dir.join("eng.traineddata"), &header).unwrap();
        assert!(ocr_folder(&options).is_err());
        fs::write(dir.join("deu.traineddata"), &header).unwrap();
        assert_eq!(ocr_folder(&options).unwrap(), dir);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn progress_tracks_pages_and_export_without_counting_duplicate_lines() {
        let mut progress = Progress::default();
        let mut done = BTreeSet::new();
        observe_progress(
            &mut progress,
            "INFO [book] Book 560 | 17 sheets in score.pdf",
            &mut done,
        );
        observe_progress(
            &mut progress,
            "INFO [book#4] StepMonitoring 98 | TEXTS",
            &mut done,
        );
        assert_eq!(progress.total_pages, Some(17));
        assert_eq!(progress.current_page, Some(4));
        assert_eq!(progress.step, "TEXTS");
        for _ in 0..2 {
            observe_progress(
                &mut progress,
                "INFO [book#4] Book 2050 | End of Stub#4",
                &mut done,
            );
        }
        assert_eq!(progress.completed_pages, 1);
        observe_progress(
            &mut progress,
            "INFO [book] PartwiseBuilder 2707 | Exporting sheet(s): [#1#2]",
            &mut done,
        );
        assert_eq!(progress.phase, "exporting");
        assert_eq!(progress.current_page, None);
    }

    #[test]
    fn changed_source_or_settings_cannot_reuse_failed_recognition() {
        let root = temporary_dir();
        let old = root.join("old");
        fs::create_dir_all(old.join("input")).unwrap();
        fs::create_dir_all(old.join("output")).unwrap();
        fs::write(old.join("input/score.pdf"), b"original").unwrap();
        fs::write(old.join("output/score.omr"), b"fixture").unwrap();
        fs::write(
            old.join("engine.log"),
            b"ArrayIndexOutOfBoundsException MetronomeInter.recognizeNote",
        )
        .unwrap();
        let options = Options::default();
        let job = Job {
            recognition_revision: RECOGNITION_REVISION,
            id: "old".into(),
            score_id: "score".into(),
            status: "failed".into(),
            created_at: 1,
            options: options.clone(),
            source: "/source/score.pdf".into(),
            engine: "Audiveris".into(),
            artifacts: vec![],
            warnings: vec![],
            error: None,
            log_tail: String::new(),
            progress: None,
        };
        persist(&old, &job).unwrap();
        let source = root.join("score.pdf");
        fs::write(&source, b"original").unwrap();
        assert!(resumable_project(&root, &root.join("new"), "score", &source, &options).is_some());
        let mut legacy = serde_json::to_value(&job).unwrap();
        legacy
            .as_object_mut()
            .unwrap()
            .remove("recognition_revision");
        fs::write(old.join("job.json"), serde_json::to_vec(&legacy).unwrap()).unwrap();
        assert!(resumable_project(&root, &root.join("new"), "score", &source, &options).is_none());
        persist(&old, &job).unwrap();
        let grand="<system><part logical-id=\"3\"><staff-configuration line-count=\"5\"/><staff-configuration line-count=\"5\"/></part></system>";
        let split="<system><part logical-id=\"1\"><staff-configuration line-count=\"5\"/></part><part logical-id=\"2\"><staff-configuration line-count=\"5\"/></part></system>";
        let layout_book=format!("<book software-version=\"5.11.0\"><sheet number=\"1\"><page id=\"1\">{}{split}{}</page></sheet><score><logical-part id=\"1\" staff-count=\"1\"/><logical-part id=\"2\" staff-count=\"1\"/><logical-part id=\"3\" staff-count=\"2\"/><page sheet-number=\"1\" sheet-page-id=\"1\"/></score></book>",grand.repeat(3),grand.repeat(4));
        let write_book = |bytes: &[u8]| {
            let mut zip = zip::ZipWriter::new(File::create(old.join("output/score.omr")).unwrap());
            zip.start_file("book.xml", zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(bytes).unwrap();
            zip.finish().unwrap();
        };
        let mut completed = job.clone();
        completed.recognition_revision = 2;
        completed.status = "complete".into();
        persist(&old, &completed).unwrap();
        write_book(layout_book.as_bytes());
        assert!(resumable_project(&root, &root.join("new"), "score", &source, &options).is_some());
        write_book(layout_book.replace(split, grand).as_bytes());
        assert!(resumable_project(&root, &root.join("new"), "score", &source, &options).is_none());
        persist(&old, &job).unwrap();
        fs::write(&source, b"changed!").unwrap();
        assert!(resumable_project(&root, &root.join("new"), "score", &source, &options).is_none());
        fs::write(&source, b"original").unwrap();
        let changed = Options {
            dpi: 300,
            ..options
        };
        assert!(resumable_project(&root, &root.join("new"), "score", &source, &changed).is_none());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn review_keeps_musicxml_bytes_and_all_movements() {
        let dir = temporary_dir();
        let xml = br#"<?xml version="1.0"?><score-partwise><part-list/><part id="P1"><measure number="1"><note><pitch><step>C</step><octave>4</octave></pitch><duration>1</duration><notations><ornaments><trill-mark/></ornaments></notations></note></measure></part></score-partwise>"#;
        for name in ["score.mvt1.xml", "score.mvt2.xml"] {
            fs::write(dir.join(name), xml).unwrap();
        }
        fs::write(dir.join("score.omr"), b"project fixture").unwrap();
        let mut artifacts = Vec::new();
        let mut warnings = Vec::new();
        collect(&dir, &dir, 0, &mut artifacts, &mut warnings).unwrap();
        assert_eq!(artifacts.len(), 3);
        assert_eq!(
            artifacts
                .iter()
                .filter(|a| a.review.as_ref().is_some_and(|r| r.notes == 1))
                .count(),
            2
        );
        for name in ["score.mvt1.xml", "score.mvt2.xml"] {
            assert_eq!(fs::read(dir.join(name)).unwrap(), xml);
        }
        fs::remove_dir_all(dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn runner_cancellation_reaps_the_process() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temporary_dir();
        let mut header = vec![0u8; 64];
        header[..4].copy_from_slice(&6u32.to_le_bytes());
        header[12..20].copy_from_slice(&52i64.to_le_bytes());
        header[28..36].copy_from_slice(&60i64.to_le_bytes());
        fs::write(dir.join("eng.traineddata"), &header).unwrap();
        let launcher = dir.join("engine");
        fs::write(&launcher, b"#!/bin/sh\nexec sleep 30\n").unwrap();
        fs::set_permissions(&launcher, fs::Permissions::from_mode(0o700)).unwrap();
        let options = Options {
            tessdata_path: dir.display().to_string(),
            ..Options::default()
        };
        let job = Job {
            recognition_revision: RECOGNITION_REVISION,
            id: "1".into(),
            score_id: "test".into(),
            status: "running".into(),
            created_at: 0,
            options: options.clone(),
            source: "test.pdf".into(),
            engine: launcher.display().to_string(),
            artifacts: vec![],
            warnings: vec![],
            error: None,
            log_tail: String::new(),
            progress: None,
        };
        let active = Arc::new(Active {
            job: Mutex::new(job),
            cancel: AtomicBool::new(false),
        });
        let worker = active.clone();
        let cancel = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            worker.cancel.store(true, Ordering::Relaxed);
        });
        let start = Instant::now();
        let error = run(
            &dir,
            &active,
            launcher.to_str().unwrap(),
            Path::new("test.pdf"),
            &options,
        )
        .unwrap_err();
        cancel.join().unwrap();
        assert!(error.contains("cancelled"));
        assert!(start.elapsed() < Duration::from_secs(5));
        assert!(dir.join("engine.log").is_file());
        fs::remove_dir_all(dir).unwrap();
    }

    /// No network is used by this test. Supply an installed engine and a local
    /// public-domain score; this exercises the same runner used by the desktop.
    #[test]
    #[ignore = "requires local Audiveris 5.11 and SONORA_OMR_TEST_INPUT"]
    fn local_engine_exports_reviewable_score() {
        let engine = std::env::var("SONORA_AUDIVERIS").expect("SONORA_AUDIVERIS");
        let input =
            PathBuf::from(std::env::var("SONORA_OMR_TEST_INPUT").expect("SONORA_OMR_TEST_INPUT"));
        let dir = std::env::temp_dir().join(format!(
            "sonora-omr-smoke-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&dir).unwrap();
        let mut options = Options {
            last_page: Some(1),
            languages: std::env::var("SONORA_OMR_TEST_LANGUAGES").unwrap_or_else(|_| "eng".into()),
            ..Options::default()
        };
        if let Ok(context) = std::env::var("SONORA_OMR_TEST_AUTO_CONTEXT") {
            options = automatic_options(&context);
            options.last_page = Some(1);
        }
        if input.extension().is_some_and(|e| e == "omr")
            || std::env::var("SONORA_OMR_TEST_FULL_BOOK").is_ok()
        {
            options.last_page = None;
        }
        let job = Job {
            recognition_revision: RECOGNITION_REVISION,
            id: "1".into(),
            score_id: "test".into(),
            status: "running".into(),
            created_at: 0,
            options: options.clone(),
            source: input.display().to_string(),
            engine: engine.clone(),
            artifacts: vec![],
            warnings: vec![],
            error: None,
            log_tail: String::new(),
            progress: None,
        };
        let active = Active {
            job: Mutex::new(job),
            cancel: AtomicBool::new(false),
        };
        let input = if input.extension().is_some_and(|e| e == "omr") {
            fs::create_dir_all(dir.join("output")).unwrap();
            let destination = dir.join("output/recovered.omr");
            fs::copy(&input, &destination).unwrap();
            destination
        } else {
            input
        };
        let success = run(&dir, &active, &engine, &input, &options).unwrap();
        let mut artifacts = Vec::new();
        let mut warnings = Vec::new();
        collect(&dir.join("output"), &dir, 0, &mut artifacts, &mut warnings).unwrap();
        artifacts.sort_by(|a, b| a.name.cmp(&b.name));
        warnings.extend(diagnostics(&dir, &artifacts, &options));
        let mut snapshot = active.job.lock().unwrap().clone();
        snapshot.status = if success { "complete" } else { "failed" }.into();
        snapshot.artifacts = artifacts.clone();
        snapshot.warnings.extend(warnings.clone());
        persist(&dir, &snapshot).unwrap();
        println!(
            "Output: {}\nArtifacts: {artifacts:#?}\nWarnings: {warnings:#?}\n{}",
            dir.display(),
            tail(&dir.join("engine.log"))
        );
        assert!(success);
        assert!(artifacts.iter().any(|a| a.kind == "project"));
        assert!(artifacts.iter().any(|a| a
            .review
            .as_ref()
            .is_some_and(|r| r.notes > 0 && r.parts > 0)));
        assert!(
            !warnings
                .iter()
                .any(|w| w.contains("Missing support") || w.contains("No installed OCR")),
            "{warnings:?}"
        );
        if std::env::var("SONORA_OMR_TEST_EXPECT_LAYOUT_REPAIR").is_ok() {
            let report: serde_json::Value =
                serde_json::from_slice(&fs::read(dir.join("layout-report.json")).unwrap()).unwrap();
            assert!(report["systems_rejoined"].as_u64().unwrap() > 0);
            assert!(dir.join("recognition-original.omr").is_file());
            assert!(!layout::needs_repair(&dir.join("output/recovered.omr")));
            let (total, pages) = project::pages(&dir.join("output/recovered.omr")).unwrap();
            assert_eq!(total as usize, pages.len());
        }
        if let Ok(expected) = std::env::var("SONORA_OMR_TEST_EXPECT_PARTS") {
            let expected = expected.parse::<usize>().unwrap();
            for artifact in artifacts.iter().filter(|a| a.kind == "musicxml") {
                assert_eq!(artifact.review.as_ref().unwrap().parts, expected);
            }
        }
        if let Ok(expected) = std::env::var("SONORA_OMR_TEST_EXPECT_METER") {
            let (beats, unit) = expected.split_once('/').unwrap();
            let artifact = artifacts.iter().find(|a| a.kind == "musicxml").unwrap();
            let xml = fs::read_to_string(dir.join(&artifact.name)).unwrap();
            let first_measure = xml
                .split("<measure ")
                .nth(1)
                .unwrap()
                .split("</measure>")
                .next()
                .unwrap();
            let compact: String = first_measure
                .chars()
                .filter(|c| !c.is_whitespace())
                .collect();
            assert!(
                compact.contains(&format!(
                    "<beats>{beats}</beats><beat-type>{unit}</beat-type>"
                )),
                "Initial meter was not preserved: {expected}"
            );
        }
        if std::env::var("SONORA_OMR_TEST_EXPECT_LYRICS").is_ok() {
            assert!(
                artifacts
                    .iter()
                    .any(|a| a.review.as_ref().is_some_and(|r| r.lyrics > 0)),
                "Expected recognized lyrics"
            );
        }
    }
}
