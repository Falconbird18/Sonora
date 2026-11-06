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
Articulations, dynamics and tremolos are enabled. Lyrics remain enabled for vocal
and unknown scores; clearly instrumental metadata disables lyric searches so
expression text is not treated as sung syllables. Vocal metadata takes precedence
when singers and instruments appear together. Small-note searches are
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

Staff grouping accepts a brace even when internal barlines do not connect the
staves, preserving piano and other grand-staff parts through cadenzas. Header
recognition searches six interlines after a clef/key and considers up to eight
classifier candidates for time/key items, keeping the engine's existing confidence
and geometric checks. This helps prevent an incompletely recognized key from
hiding a time signature and allowing its digits to become false notes. It does not
force a key, meter, pitch or duration based on a composer's name or work title.

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

Automatic conversion also enables recovery of partially fused beam borders. Older
engravings can have a short beam hook joined to the beam beneath it; rejecting
this structure can turn sixteenths and eighths into quarters. Missing opposite
edges may be reconstructed by the engine, while its ink-density, thickness and
stem-link checks still apply. This adds no external models or services and does
not edit durations in the exported MusicXML.

## Whole-score structure consistency

After recognition and before export, Sonora checks physical staff groups across
each complete movement. An isolated two-part split is rejoined only when the
surrounding systems agree on a single two-staff part, at least 85% of the movement
uses that same grand staff, every system has exactly two standard five-line
staves, and measure IDs and source staff order agree. Named instruments,
lyric-bearing parts, mixed ensembles and ambiguous instrumentation changes are
excluded. This is source-layout reconciliation, not removal of MusicXML parts
based on their names or apparent emptiness.

The repair joins the two physical staff containers, their corresponding measures,
barlines and notation references in a private Audiveris project. Voice IDs remain
separate, and the symbol graph, source pixels and recognized noteheads are retained.
Unused logical parts created by the split are then removed from that movement.
Audiveris performs the final MusicXML export, including inherited key signatures.
This can also correct accidental inheritance that was broken by the false part
boundary. It does not identify every wrong pitch or rhythm.

The original project is retained as `recognition-original.omr`, with a
`layout-report.json` recording repaired systems and source pages. Changes are
validated before an atomic file replacement. If a candidate contains unsupported
or conflicting data, Sonora keeps the original and surfaces a review note.

**Convert again** can reuse a completed conversion with matching source bytes and
recognition options when this specific structure repair is needed. It re-exports
all movements without repeating note recognition. A changed recognition profile,
including enabling beam-border recovery for an older conversion, requires fresh
processing so the new result does not silently retain old recognition errors.

## Progress and recovery

Conversion shows preparation, recognition, a whole-score structure check and
MusicXML export. During recognition,
source-page counts and the current task come from the engine log. Page counts
measure pages processed, including pages requiring review; they are not an accuracy
score or a time estimate. MusicXML export has a separate indeterminate indicator.

Recognition saves the book before export. Sonora repairs Audiveris 5.11's empty
run-table serialization in a private project copy so its exporter can reopen it.
No pixels are added and the original failed job is retained. If recognition hits
the known metronome classifier index error, Sonora automatically retries the saved
book with a bounded metronome candidate search. Completed recognition is reused.
Clicking **Convert again** also reuses a failed book with this error, provided its
source bytes, recognition options and recognition-pipeline revision match. Changed
inputs and failed projects from older pipeline revisions are processed afresh.
Other errors remain visible in the log; recovery does not guarantee recognition
accuracy. Missing or unfinished pages are called out in the result.

## Lifecycle and storage

Recognition runs on a native background thread, one score at a time. Cancelling
stops the engine; closing Sonora stops its worker. On Unix the engine gets its own
process group, so shell-launched Java children are stopped as well. Unexpectedly
interrupted jobs are identified when the app next opens. Recognition has a two-hour
limit. `-swap` checkpoints each processed page and releases it to reduce memory
use. Sonora avoids the per-step `-save` option, which rewrites the complete project
after every internal step. A hard interruption can therefore lose the page currently
being processed, while completed pages remain saved.

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
The integration test also accepts `SONORA_OMR_TEST_EXPECT_PARTS` and
`SONORA_OMR_TEST_EXPECT_METER` (for example, `1` and `2/4`) to check known source
structure. `SONORA_OMR_TEST_EXPECT_LAYOUT_REPAIR=1` with a saved `.omr` input
additionally checks the structural repair, retained original and complete page
coverage. Use a complete multi-movement book to guard against phantom parts that
single-page fixtures cannot reveal. `SONORA_OMR_TEST_FULL_BOOK=1` runs recognition
on every page of a PDF instead of the default one-page smoke check. These are functional tests, not an accuracy benchmark.
