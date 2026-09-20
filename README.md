# Sonora

A fast, cross-platform sheet music library and score viewer built with Svelte, Vite, PDF.js, and Tauri.

Import a folder of PDF scores, browse by composer, annotate with pen, highlighter, lines, arrows, text notes, and musical symbols.

## Features

- **Reliable PDF rendering** — PDF.js canvas API, high-DPI output, progress feedback, dual-page view, and adjacent-page prefetch
- **Annotations that stick** — freehand, highlighter, line/arrow, text notes, and music-symbol stamps stored in IndexedDB (Dexie)
- **Undo / redo** per page, eraser (strokes, symbols, and notes), move tool
- **Library** — one synced score folder (native desktop or browser File System Access), favorites, search, grid/list, sort filters
- **Focus mode** (`F`), keyboard page turns, thumbnail-friendly layout
- **Hands-free page turns** — optional webcam + MediaPipe Face Landmarker (head yaw, blink, wink). All processing is on-device.
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

## Hands-free gestures

Open **Settings → Hands-free page turns** and enable camera gestures.

| Gesture | Action |
| --- | --- |
| Head turn left (yaw) | Previous page |
| Head turn right (yaw) | Next page |
| Deliberate blink (both eyes) | Next page (optional) |
| Left wink | Previous page (optional) |
| Right wink | Next page (optional) |

Sensitivity, hold time, and cooldown are adjustable. Camera access is requested only when the feature is enabled; models run fully on-device via MediaPipe.

## Stack

Svelte 5 · Vite · PDF.js · Dexie · Lucide · MediaPipe Tasks Vision · Tauri 2

## Contributing

Contributions are welcome. Simply open a PR.
