# Local score digitization

Open a score in the desktop viewer and choose **Digitize score to MusicXML**
(the music-note button in the top toolbar). Sonora runs an installed Audiveris
5.11 process locally. Recognition never sends score files to an external service.
The browser build explains the desktop requirement instead of attempting OMR.

## Setup

1. Install [Audiveris 5.11.0](https://github.com/Audiveris/audiveris/releases/tag/5.11.0)
   for your platform. Sonora does not bundle or automatically install it.
2. In **Audiveris setup**, choose the native launcher, normally `bin/Audiveris`,
   `Audiveris.exe`, or `Audiveris.bat`. A runnable JAR is also supported when Java
   and its required classpath are configured. Alternatively, put `Audiveris` on
   PATH or set `SONORA_AUDIVERIS` before launching Sonora.
3. Install the needed OCR languages through Audiveris **Tools → Languages**.
   You can instead choose a folder containing `.traineddata` dictionaries from
   [tesseract-ocr/tessdata](https://github.com/tesseract-ocr/tessdata).
   **Audiveris 5.11 uses the legacy OCR engine: `tessdata_fast` and `tessdata_best`
   alone do not work.** Sonora checks the dictionary header for the required
   legacy components, as well as checking that every requested language exists.
4. Specify OCR languages with three-letter codes, for example `deu+eng` for a
   German vocal score, `fra`, `ita`, or `lat`. Use only the languages present in
   the score. Instrumental scores also need OCR for tempo, technique and part names.

An explicit OCR folder takes priority over `TESSDATA_PREFIX`. Without either,
Sonora searches common Audiveris and system Tesseract data directories, then sets
`TESSDATA_PREFIX` on the child process to the verified folder. Other installations
can use the folder picker. Initial setup and downloads are separate from offline
recognition. Audiveris remains a separate program with its own license; no
Audiveris code, binaries, classifiers or OCR dictionaries are shipped in Sonora.

## Fidelity choices

- Sonora copies the original PDF or image into a private job directory. It does
  not use the viewer's screen-resolution raster or thumbnail as recognition input.
- Audiveris renders PDFs in grayscale at 400 DPI by default. Choose 300 DPI for
  standard-size notation when resources are limited. Image inputs keep their
  original resolution; the DPI selector does not enlarge photographs or restore
  information missing from a scan.
- Use a page range to exclude covers, front matter and prose. Page numbers refer
  to the PDF, including its covers. Starting after page 1 requires an explicit end.
- Lyrics, articulations, dynamics above/below the staff and tremolos are enabled.
  Enable cue notes/small beams, above-staff lyrics and fingering recognition when
  those features are present. Extra searches can produce false interpretations.
- The engine's uncompressed MusicXML is saved **byte for byte**. Sonora does not
  reduce it to a note list or rewrite unknown elements. Thus recognized voices,
  chords, staff assignments, ties, slurs, tuplets, articulations, ornaments,
  lyrics, transposing-instrument declarations, layout and directions survive
  export to the extent Audiveris includes them.
- All movements exported by Audiveris are listed separately. The `.omr` project
  is retained with grayscale images, so it can be opened in Audiveris for
  corrections, revised binarization and re-export. Save each MusicXML movement
  and the project through the panel's save buttons.

Audiveris's own [scanning guide](https://audiveris.github.io/audiveris/_pages/guides/advanced/scanning/)
describes suitable source quality. For phone images, photograph the page flat,
well-lit and tightly framed; perspective distortion, page curvature and shadows
can still impair recognition. Sonora currently relies on Audiveris's staff and
binarization processing, without adding a separate perspective-correction engine.

## Review and recovery

Recognition runs on a background native thread with a single active job. `-swap`
allows Audiveris to release processed sheets; stdout/stderr go to a file rather
than potentially blocking pipes. The job can be cancelled, and has a two-hour
limit; use shorter page ranges for large books. Closing the panel or leaving the
score does not cancel work. Reopening reconnects to the job. Closing Sonora
cancels active recognition and waits for its worker to stop. On Unix, the engine
gets its own process group so cancellation also stops shell-launched Java children.
Use the native Audiveris executable on Windows. After an unexpected shutdown, the
next launch identifies unfinished jobs as interrupted.

An exit code of zero is insufficient for success. Sonora requires a parseable
partwise MusicXML score containing notes, surfaces OCR failures and engine
warnings, and checks the saved book for rejected/unfinished selected pages.
Warnings do not cause exported notation to be deleted or automatically repaired.
Partial exports and projects remain available after a failure or cancellation.

The read-only structural review flags missing/invalid pitch and duration,
voice backups before a measure's start, and total measure durations inconsistent
with the meter. It accounts for chords, grace notes, backup/forward, inherited
and additive time signatures, division changes and encoded tuplet durations.
Implicit pickups are exempt from underfill warnings. It does not prove pitch
correctness, verify every individual voice or tie/slur endpoint, implement full
MusicXML schema validation, or measure OMR accuracy. Cadenzas, polymeter and
unusual historical notation can need manual review. Measure warnings identify
the MusicXML part and measure. Warning lists are bounded for large scores.

Jobs live in `<Sonora app-data>/omr/<job-id>/`, containing the source snapshot,
`arguments.json`, `engine.log`, `job.json`, and the complete `output/` directory.
The source is never replaced. Historical jobs are retained, including failed
attempts; large scores and repeated attempts consume disk space. Source and
options can be inspected in the panel. This initial implementation exports
MusicXML for review/editing in notation software; it does not yet replace the PDF
viewer with engraved MusicXML or implement in-app transposition.
Audiveris's configured Java heap limit still applies; on constrained laptops,
choose 300 DPI and shorter page ranges.

## Verification

```bash
npm run check
npm run build
cargo test --manifest-path src-tauri/Cargo.toml --lib --offline
```

Run Vite and open `/tests/ui/omr.html` for the automated mocked-IPC viewer
regression (start, disabling settings, reconnect after closing, review, save,
cancellation). It shows `PASS` or `FAIL` at the top of the page.

The ignored native smoke test uses the real runner and collector, without
network access in the test:

```bash
SONORA_AUDIVERIS=/path/to/Audiveris \
TESSDATA_PREFIX=/path/to/legacy-compatible/tessdata \
SONORA_OMR_TEST_INPUT=/path/to/local/score.pdf \
cargo test --manifest-path src-tauri/Cargo.toml --lib \
  omr::tests::local_engine_exports_reviewable_score --offline -- --ignored --nocapture
```

For a vocal fixture, also set `SONORA_OMR_TEST_LANGUAGES=deu+eng` (or its language)
and `SONORA_OMR_TEST_EXPECT_LYRICS=1`. The test selects page 1, asserts usable
MusicXML and a saved project, and prints the retained temporary output directory.
A suitable public test input is Audiveris's
[Schumann Dichterliebe example](https://github.com/Audiveris/audiveris/blob/5.11.0/data/examples/Dichterliebe01.pdf).
This is a functional conversion test, not an accuracy benchmark.
