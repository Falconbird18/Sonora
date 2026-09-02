# Sonora

A fast, offline-capable sheet music library and score viewer built with Svelte 5, Vite, PDF.js, and Tauri.

Import a folder of PDF scores, browse by composer, annotate with pen, highlighter, lines, arrows, text notes, and musical symbols (SMuFL via Leland).

## Features

- **Reliable PDF rendering** — PDF.js canvas API, high-DPI output, progress feedback, dual-page view, and adjacent-page prefetch
- **Annotations that stick** — freehand, highlighter, line/arrow, text notes, and music-symbol stamps stored in IndexedDB (Dexie)
- **Stylus pressure** for natural pen weight
- **Undo / redo** per page, eraser (strokes, symbols, and notes), move tool
- **Library** — one synced score folder (native desktop or browser File System Access), favorites, search, grid/list, sort filters
- **Local composer portraits** — bundled JPEGs in `public/composers/` (no Wikimedia requests at runtime)
- **Focus mode** (`F`), keyboard page turns, thumbnail-friendly layout
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
npm run tauri:dev
```

```bash
npm run tauri:build
```

## Composer portraits

Portraits are downloaded **once** into `public/composers/` so the desktop app never fetches them on launch.

```bash
npm run portraits
```

The script talks to Wikimedia Commons with a proper User-Agent, writes JPEGs, and is skipped for files that already exist.

## Fonts

Musical symbols use **Leland** (SIL OFL) from [MuseScoreFonts/Leland](https://github.com/MuseScoreFonts/Leland).  
Place `Leland.otf` in `public/fonts/` (or keep the copy at the repo root). The viewer looks for both `/fonts/Leland.otf` and `/Leland.otf`.

## Keyboard

| Key | Action |
| --- | --- |
| `←` `→` `Space` `PageUp/Down` | Turn pages |
| `F` | Reading / focus mode |
| `P` `H` `E` `S` `T` | Pen, highlight, eraser, symbols, text |
| `Esc` | Close panels, then return to the library |
| `Ctrl/Cmd + scroll` | Zoom |

## Stack

Svelte 5 · Vite · PDF.js · Dexie · Lucide · Tauri 2
