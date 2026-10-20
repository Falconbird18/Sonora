//! Portable, versioned ZIP archives. File data is streamed outside the UI thread.
use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs::{self, File},
    io::{Read, Seek, SeekFrom, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use zip::{write::SimpleFileOptions, CompressionMethod, ZipArchive, ZipWriter};

const MANIFEST_LIMIT: u64 = 32 * 1024 * 1024;
const FILE_LIMIT: u64 = 4 * 1024 * 1024 * 1024;
const TOTAL_LIMIT: u64 = 32 * 1024 * 1024 * 1024;
#[derive(Deserialize)]
pub struct ExportSource {
    score_id: String,
    path: Option<String>,
    bytes_base64: Option<String>,
}
#[derive(Serialize)]
pub struct ImportedFile {
    source_id: String,
    native_path: String,
    relative_path: String,
    size: u64,
    modified_at: u64,
}
#[derive(Serialize)]
pub struct ImportResult {
    manifest: Value,
    files: Vec<ImportedFile>,
}
fn stamp() -> u128 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos()
}
fn checked_manifest(manifest: &Value) -> Result<&Vec<Value>, String> {
    if manifest["format"] != "sonora-library" || manifest["version"] != 1 {
        return Err("This is not a supported Sonora library archive.".into());
    }
    let scores = manifest["scores"]
        .as_array()
        .ok_or("Archive is missing its score catalogue")?;
    if scores.len() > 100_000
        || !manifest["annotations"].is_array()
        || !manifest["lists"].is_array()
    {
        return Err("Invalid library catalogue".into());
    }
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for score in scores {
        let id = score["id"].as_str().ok_or("Score is missing its id")?;
        let pdf = score["pdf"].as_str().ok_or("Score is missing its PDF")?;
        if !ids.insert(id)
            || !paths.insert(pdf)
            || !pdf.starts_with("scores/")
            || !pdf.ends_with(".pdf")
            || pdf.contains('\\')
            || Path::new(pdf)
                .components()
                .any(|c| !matches!(c, std::path::Component::Normal(_)))
        {
            return Err("Invalid or duplicate archive score path".into());
        }
        if !score["title"].is_string() || !score["composer"].is_string() {
            return Err("Invalid score metadata".into());
        }
    }
    Ok(scores)
}
fn pdf_header<R: Read + Seek>(reader: &mut R) -> Result<(), String> {
    let mut header = [0u8; 5];
    reader.read_exact(&mut header).map_err(|e| e.to_string())?;
    reader.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    if &header != b"%PDF-" {
        return Err("A library file is not a valid PDF".into());
    }
    Ok(())
}
struct Cleanup(PathBuf);
impl Drop for Cleanup {
    fn drop(&mut self) {
        if self.0.is_dir() {
            let _ = fs::remove_dir_all(&self.0);
        } else {
            let _ = fs::remove_file(&self.0);
        }
    }
}

pub fn write_archive(
    destination: &Path,
    manifest: &Value,
    sources: Vec<ExportSource>,
    root: Option<&Path>,
) -> Result<(), String> {
    let scores = checked_manifest(manifest)?;
    if sources.len() != scores.len() {
        return Err("Every score must have a PDF to export the complete library".into());
    }
    let root = root
        .map(|p| p.canonicalize())
        .transpose()
        .map_err(|e| e.to_string())?;
    let parent = destination.parent().ok_or("Invalid destination")?;
    let temporary = parent.join(format!(".sonora-export-{}.zip.tmp", stamp()));
    let cleanup = Cleanup(temporary.clone());
    let file = File::create(&temporary).map_err(|e| e.to_string())?;
    let mut zip = ZipWriter::new(file);
    let options = SimpleFileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);
    zip.start_file("library.json", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(&serde_json::to_vec_pretty(manifest).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    for (score, source) in scores.iter().zip(sources) {
        if score["id"].as_str() != Some(source.score_id.as_str()) {
            return Err("Score snapshot changed during export. Try again.".into());
        }
        zip.start_file(score["pdf"].as_str().unwrap(), options)
            .map_err(|e| e.to_string())?;
        if let Some(path) = source.path {
            let path = PathBuf::from(path)
                .canonicalize()
                .map_err(|e| format!("Could not read {}: {e}", score["title"]))?;
            if !root
                .as_ref()
                .map(|root| path.starts_with(root))
                .unwrap_or(false)
            {
                return Err("A score is outside the selected library folder".into());
            }
            let mut file = File::open(path).map_err(|e| e.to_string())?;
            pdf_header(&mut file)?;
            std::io::copy(&mut file, &mut zip).map_err(|e| e.to_string())?;
        } else if let Some(encoded) = source.bytes_base64 {
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(encoded)
                .map_err(|e| e.to_string())?;
            if !bytes.starts_with(b"%PDF-") {
                return Err("A score has invalid PDF data".into());
            }
            zip.write_all(&bytes).map_err(|e| e.to_string())?;
        } else {
            return Err(format!("The PDF for {} is unavailable", score["title"]));
        }
    }
    zip.start_file("README.txt", options)
        .map_err(|e| e.to_string())?;
    zip.write_all(b"Sonora portable library, version 1\n\nImport this ZIP using Sonora > Settings > Library sharing > Import library.\nPDFs are in scores/. library.json contains metadata, editable annotations, and ordered lists.\nOriginal PDFs are unchanged; annotations remain editable in Sonora.\n").map_err(|e|e.to_string())?;
    zip.finish()
        .map_err(|e| e.to_string())?
        .sync_all()
        .map_err(|e| e.to_string())?;
    fs::rename(&temporary, destination).map_err(|e| e.to_string())?;
    drop(cleanup);
    Ok(())
}

pub fn read_archive(archive: &Path, root: &Path) -> Result<ImportResult, String> {
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let mut zip = ZipArchive::new(File::open(archive).map_err(|e| e.to_string())?)
        .map_err(|e| format!("Cannot open library ZIP: {e}"))?;
    let manifest: Value = {
        let mut file = zip
            .by_name("library.json")
            .map_err(|_| "ZIP has no Sonora library catalogue")?;
        if file.size() > MANIFEST_LIMIT {
            return Err("Library catalogue is too large".into());
        }
        let mut bytes = Vec::new();
        file.by_ref()
            .take(MANIFEST_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|e| e.to_string())?;
        serde_json::from_slice(&bytes).map_err(|e| format!("Invalid catalogue: {e}"))?
    };
    let scores = checked_manifest(&manifest)?;
    let shared_name = format!(
        "{} (shared)",
        crate::sanitize_path_segment(
            archive
                .file_stem()
                .and_then(|name| name.to_str())
                .unwrap_or("Sonora Library")
        )
    );
    let destination = crate::unique_dest(&root, &shared_name)?;
    let folder = destination
        .file_name()
        .unwrap()
        .to_string_lossy()
        .to_string();
    let staging = root.join(format!(".sonora-import-{}", stamp()));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let cleanup = Cleanup(staging.clone());
    let mut files = Vec::new();
    let mut total = 0u64;
    for (index, score) in scores.iter().enumerate() {
        let entry_name = score["pdf"].as_str().unwrap();
        let mut entry = zip
            .by_name(entry_name)
            .map_err(|_| format!("Missing PDF: {}", score["title"]))?;
        total = total
            .checked_add(entry.size())
            .ok_or("Archive exceeds the import size limit")?;
        if entry.size() > FILE_LIMIT || total > TOTAL_LIMIT || !entry.is_file() {
            return Err("Archive exceeds the import size limit".into());
        }
        let filename = format!(
            "{:05} - {}.pdf",
            index + 1,
            crate::sanitize_path_segment(score["title"].as_str().unwrap())
        );
        let path = staging.join(&filename);
        let mut target = File::create(&path).map_err(|e| e.to_string())?;
        let written = std::io::copy(&mut entry.by_ref().take(FILE_LIMIT + 1), &mut target)
            .map_err(|e| e.to_string())?;
        if written != entry.size() {
            return Err("Truncated or oversized PDF in archive".into());
        }
        drop(target);
        pdf_header(&mut File::open(&path).map_err(|e| e.to_string())?)?;
        fs::write(
            path.with_extension("sonora.json"),
            serde_json::to_vec_pretty(score).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        let metadata = path.metadata().map_err(|e| e.to_string())?;
        files.push(ImportedFile {
            source_id: score["id"].as_str().unwrap().into(),
            native_path: destination.join(&filename).to_string_lossy().into(),
            relative_path: format!("{folder}/{filename}"),
            size: written,
            modified_at: metadata
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|t| t.as_millis() as u64)
                .unwrap_or(0),
        });
    }
    // Keep a recovery copy of annotations and programs alongside the imported PDFs.
    fs::write(
        staging.join("library.json"),
        serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    fs::rename(&staging, &destination).map_err(|e| e.to_string())?;
    drop(cleanup);
    Ok(ImportResult { manifest, files })
}

#[tauri::command]
pub async fn export_library_archive(
    manifest: Value,
    sources: Vec<ExportSource>,
    library_root: Option<String>,
) -> Result<Option<String>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Export complete Sonora library")
        .add_filter("Sonora library ZIP", &["zip"])
        .set_file_name("Sonora Library.zip")
        .save_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_path_buf();
    let output = path.to_string_lossy().to_string();
    tauri::async_runtime::spawn_blocking(move || {
        write_archive(
            &path,
            &manifest,
            sources,
            library_root.as_deref().map(Path::new),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(Some(output))
}
#[tauri::command]
pub async fn import_library_archive(library_root: String) -> Result<Option<ImportResult>, String> {
    let Some(file) = rfd::AsyncFileDialog::new()
        .set_title("Import a Sonora library")
        .add_filter("Sonora library ZIP", &["zip"])
        .pick_file()
        .await
    else {
        return Ok(None);
    };
    let path = file.path().to_path_buf();
    tauri::async_runtime::spawn_blocking(move || read_archive(&path, Path::new(&library_root)))
        .await
        .map_err(|e| e.to_string())?
        .map(Some)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn complete_archive_round_trip_and_path_validation() {
        let root = std::env::temp_dir().join(format!("sonora-archive-{}", stamp()));
        fs::create_dir_all(&root).unwrap();
        let _cleanup = Cleanup(root.clone());
        let pdf = b"%PDF-1.7\noriginal PDF bytes\n%%EOF";
        fs::write(root.join("original.pdf"), pdf).unwrap();
        let manifest = serde_json::json!({"format":"sonora-library","version":1,"scores":[{"id":"old","title":"Sonata","composer":"Bach","pdf":"scores/00000.pdf"}],"annotations":[{"scoreId":"old","pageNum":1,"notes":[{"text":"Softly"}],"stamps":[],"strokes":[]}],"lists":[{"name":"Concert","entries":[{"id":"a","scoreId":"old"},{"id":"b","scoreId":"old"}]}]});
        let archive = root.join("library.zip");
        write_archive(
            &archive,
            &manifest,
            vec![ExportSource {
                score_id: "old".into(),
                path: Some(root.join("original.pdf").to_string_lossy().into()),
                bytes_base64: None,
            }],
            Some(&root),
        )
        .unwrap();
        let imported = read_archive(&archive, &root).unwrap();
        assert_eq!(imported.files.len(), 1);
        assert_eq!(fs::read(&imported.files[0].native_path).unwrap(), pdf);
        assert_eq!(
            imported.manifest["annotations"][0]["notes"][0]["text"],
            "Softly"
        );
        assert_eq!(
            imported.manifest["lists"][0]["entries"]
                .as_array()
                .unwrap()
                .len(),
            2
        );
        let mut unsafe_manifest = manifest.clone();
        unsafe_manifest["scores"][0]["pdf"] = Value::String("scores/../../escape.pdf".into());
        assert!(checked_manifest(&unsafe_manifest).is_err());
        let mut invalid = manifest.clone();
        invalid["version"] = Value::from(99);
        assert!(checked_manifest(&invalid).is_err());
    }
}
