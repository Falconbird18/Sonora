# Sonora

A fast, cross-platform sheet music library and score viewer built with Svelte, Vite, PDFium, and Tauri.

Import individual PDFs or folders, review smart title and tag suggestions, browse by composer, and practice with a metronome, chromatic tuner, and layered annotations.

## Features

- **Reliable PDF rendering** — PDFium canvas API, high-DPI output, progress feedback, dual-page view, and adjacent-page prefetch
- **Annotations that stick** — freehand, highlighter, line/arrow, text notes, and music-symbol stamps stored in IndexedDB (Dexie)
- **Undo / redo** per page, eraser (strokes, symbols, and notes), move tool
- **Library** — one synced score folder (native desktop or browser File System Access), favorites, search, grid/list, sort filters
- **Focus mode** (`F`), keyboard page turns, thumbnail-friendly layout
- **Smart imports** — individual PDFs, folder batches, drag and drop, duplicate detection, editable review, local PDF text extraction, and desktop IMSLP metadata suggestions. Original files keep their names; imported PDFs are stored in Sonora.
- **Annotation layers** — named layers with independent visibility and stacking order; edits and undo apply to the selected layer. Legacy annotations appear in the default layer.
- **Practice tools** — separate metronome and tuner buttons open compact app panels. Metronome includes tap tempo, beat accents and volume; tuner includes cents feedback and A4 calibration (415–466 Hz). Microphone audio stays local. Closing a panel or hiding the interface keeps active audio tools running; returning to the library stops them.
- **Viewer appearance** — practice by default, with a reading default available in Settings and an interface toggle (`F`).
- **Desktop app** via Tauri with native folder picking and file access

## Develop (web)

```bash
npm install
npm run portraits   # only needed if public/composers/ is missing
npm run dev
```

```bash
npm run build
npm run preview
```

## Develop (desktop)

Requires [Rust](https://www.rust-lang.org/tools/install) and the Tauri system dependencies for your platform.

```bash
npm install
npm run portraits   # Again, only needed if public/composers/ is missing
npm run tauri:dev
```

```bash
npm run tauri:build
```

On Linux the build produces `.deb`, `.rpm`, and (when `SONORA_BUILD_APPIMAGE=1`) an AppImage. Prefer the native packages when available.

## Composer portraits

Portraits are downloaded **once** into `public/composers/` so the desktop app never fetches them on launch.

```bash
npm run portraits
```

The script talks to Wikimedia Commons with a proper User-Agent, writes JPEGs, and is skipped for files that already exist.

## Fonts

Musical symbols use **Leland** (SIL OFL) from [MuseScoreFonts/Leland](https://github.com/MuseScoreFonts/Leland).  

## Keyboard

| Key | Action |
| --- | --- |
| `←` `→` `Space` `PageUp/Down` | Turn pages |
| `F` | Reading / focus mode |
| `P` `H` `E` `S` `T` | Pen, highlight, eraser, symbols, text |
| `Esc` | Close panels, then return to the library |
| `Ctrl/Cmd + scroll` | Zoom |

## Stack

Svelte 5 · Vite · PDFium · Dexie · Lucide · Tauri 2

## Contributing

Contributions are welcome. Simply open a PR.

## Smart import and OCR

Use **Import scores** to select one or more PDFs, import a folder, or connect an existing synced folder. Review filenames, composer assignments, tags and suggested IMSLP matches before importing. IMSLP lookup requires the desktop app; ambiguous matches are offered for selection. Importing cleans the library title, including IMSLP/PMLP identifiers and filename separators, without changing original files.

Embedded PDF text is extracted locally. For scanned title pages, enable **Recognize scanned title pages locally** in the import dialog. This optional desktop feature requires the `tesseract` executable and English language data installed on the computer. Sonora renders the first page locally and pipes the PNG to Tesseract; no OCR images are uploaded. If OCR is unavailable, filename suggestions remain available. Metadata suggestions always need review.

## Verification

```bash
npm run check
npm run test:library
npm run test:practice
npm run build
cd src-tauri
cargo test --lib --offline
```

The practice checks cover filename cleanup, composer recognition, layer compatibility, isolated undo, archive preservation, and tuner accuracy using synthesized notes at 44.1 and 48 kHz. The optional native OCR integration check is `cargo test --lib local_ocr_reads_title_page -- --ignored`.
