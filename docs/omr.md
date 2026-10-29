# Automatic local score conversion

Open **Convert** in the left sidebar and choose **Convert a score**. Select a PDF,
scan or photograph; recognition starts automatically. You can also select a score
already in the library and click **Convert**. There are no recognition settings to
fill in. Sonora chooses the resolution, language packs and notation switches.

The first conversion downloads Audiveris 5.11.0, its bundled Java runtime and the
needed OCR dictionaries into Sonora's application-data folder. There is no system
installation or separate Java/Tesseract setup. Engine downloads come from official
Audiveris releases and are checked against pinned SHA-256 digests before extraction.
Compatible legacy OCR dictionaries come from the official Tesseract `tessdata`
4.1.0 release. The resulting runtime and language files are reused. After initial
setup, conversion runs offline; score files are never uploaded.

Automatic provisioning supports Linux x86-64, Windows x86-64, and macOS Intel and
Apple Silicon. Linux unpacks the official Debian archive directly using Rust
libraries. Windows uses the system MSI extraction tool; macOS mounts the official
read-only disk image and copies the application into Sonora's data folder.
The provisioning integration test has been exercised on Linux. The other platform
paths require their respective operating systems for verification.

## Reading and keeping the result

Finished movements appear in the Convert workspace. Choose **View score** to
open a movement as engraved notation in Sonora's usual viewer, or **Add to library**
to keep it. **Download MusicXML** preserves the original export. The editable
Audiveris project is also available. Conversion history lets you return to a result
after leaving the page or restarting Sonora.

Existing `.musicxml`, `.xml`, and compressed `.mxl` scores can be opened from
**Open MusicXML**, imported through **Import scores**, or discovered in a synced
score folder. PDFs and MusicXML use the same fixed-page viewer contract, including
page navigation, zoom, annotations and thumbnails. MusicXML engraving is provided
locally by a lazily loaded OpenSheetMusicDisplay bundle; there is no CDN or rendering
service. Its engraved A4 pages stay fixed when the window changes size, keeping
annotation coordinates stable. Portable library exports retain the correct file
extension, format, source bytes, metadata and annotations for both formats.

## Recognition and fidelity

Sonora passes a private copy of the original document to Audiveris, rather than a
viewer thumbnail. PDFs are rendered in grayscale at 400 DPI. Image inputs retain
their original resolution. The entire document is processed; Audiveris identifies
valid music sheets and the result reports rejected or unfinished source pages.
Lyrics, articulations, dynamics and tremolos are enabled. Small-note searches are
chosen for cue/cadenza/grace-note metadata instead of being enabled indiscriminately.
Fingering recognition is chosen for piano/study metadata. Language packs are chosen
from composer, country, title and instrument metadata, with common European
languages as a fallback. This is a metadata-based heuristic, not a guarantee of
identifying the language of an unlabelled scanned vocal score.

The engine's MusicXML is saved byte for byte, without reducing it to a note list or
rewriting unknown elements. Recognized voices, chords, ties, slurs, tuplets,
articulations, ornaments, lyrics, instrument transpositions and layout therefore
survive to the extent Audiveris exports them. The `.omr` project retains grayscale
images for correction and re-export in Audiveris. MusicXML imported into Sonora is
also stored without altering its contents. Visual engraving support is determined
by OpenSheetMusicDisplay; some notation may need review against the source.

A successful engine exit alone is insufficient: Sonora requires readable partwise
MusicXML containing notes. It surfaces OCR failures and checks source-page coverage.
A read-only structural review flags invalid pitch/duration, voice backups before
measure starts and measure durations inconsistent with the meter. It accounts for
chords, grace notes, backup/forward, inherited/additive meter, division changes and
encoded tuplet durations. It does not prove note accuracy or validate every voice,
tie/slur endpoint or the entire MusicXML schema. Review flagged measures before
using a converted score for editing or transposition. In-app transposition is not
part of this change.

Audiveris handles binarization and staff geometry. Sonora does not add a separate
perspective-correction engine for photographs. Flat, upright, evenly lit images
remain preferable; see the upstream
[scanning guide](https://audiveris.github.io/audiveris/_pages/guides/advanced/scanning/).

## Progress and recovery

Conversion shows preparation, recognition and MusicXML stages. During recognition,
source-page counts and the current task come from the engine log. Page counts
measure pages processed, including pages requiring review; they are not an accuracy
score or a time estimate. MusicXML export has a separate indeterminate indicator.

Recognition saves the book before export. Sonora repairs Audiveris 5.11's empty
run-table serialization in a private project copy so its exporter can reopen it.
No pixels are added and the original failed job is retained. If recognition hits
the known metronome classifier index error, Sonora automatically retries the saved
book with a bounded metronome candidate search. Completed recognition is reused.
Clicking **Convert again** also reuses a failed book with this error, provided its
source bytes and recognition options match. Changed inputs are processed afresh.
Other errors remain visible in the log; recovery does not guarantee recognition
accuracy. Missing or unfinished pages are called out in the result.

## Lifecycle and storage

Recognition runs on a native background thread, one score at a time. Cancelling
stops the engine; closing Sonora stops its worker. On Unix the engine gets its own
process group, so shell-launched Java children are stopped as well. Unexpectedly
interrupted jobs are identified when the app next opens. Recognition has a two-hour
limit, while `-swap` releases processed sheets to reduce memory use.

Files live under `<Sonora app-data>/omr/`: a versioned runtime, cached OCR data,
imported PDF snapshots, and job directories containing the original input,
per-stage `arguments-*.json` files, `engine.log`, `job.json` and `output/`. Historical attempts are
retained, including failed attempts, and consume disk space. Saved library scores
contain independent source blobs, so they remain readable without the job folder.
Audiveris remains a separately downloaded program with its own license; its sources
and releases are at https://github.com/Audiveris/audiveris.

## Verification

```bash
npm run check
npm run build
npm run test:pdf
npm run test:practice
cargo test --manifest-path src-tauri/Cargo.toml --lib --offline
```

With Vite on an isolated empty origin, browser fixtures report PASS/FAIL:

- `/tests/ui/convert.html`: sidebar, library-source conversion, result viewing,
  keeping/reopening MusicXML, conversion history and navigation (mocked native IPC).
- `/tests/ui/musicxml.html`: real XML/MXL engraving, pagination, visible notation,
  cancellation, cleanup, lossless import and dispatch to the PDF renderer.
- `/tests/ui/omr.html`: automatic conversion controls, reconnection, result saving
  and cancellation.

Explicit native integration checks:

```bash
# Downloads the official runtime and two language packs into /tmp, launches it,
# and verifies that a second preparation uses the cache.
cargo test --manifest-path src-tauri/Cargo.toml --lib \
  omr::runtime::tests::automatic_runtime_is_usable_and_cached -- --ignored --nocapture

# Functional conversion of a local score. No network is used by this test.
SONORA_AUDIVERIS=/path/to/Audiveris \
TESSDATA_PREFIX=/path/to/legacy-compatible/tessdata \
SONORA_OMR_TEST_INPUT=/path/to/local/score.pdf \
SONORA_OMR_TEST_LANGUAGES=deu+eng \
SONORA_OMR_TEST_EXPECT_LYRICS=1 \
cargo test --manifest-path src-tauri/Cargo.toml --lib \
  omr::tests::local_engine_exports_reviewable_score --offline -- --ignored --nocapture
```

The vocal conversion fixture is Audiveris's public
[Schumann Dichterliebe example](https://github.com/Audiveris/audiveris/blob/5.11.0/data/examples/Dichterliebe01.pdf).
These are functional tests, not an accuracy benchmark.
