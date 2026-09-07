# Sonora

A fast, cross-platform sheet music library and score viewer built with Svelte, Vite, PDF.js, and Tauri.

Import a folder of PDF scores, browse by composer, annotate with pen, highlighter, lines, arrows, text notes, and musical symbols.

## Features

- **Reliable PDF rendering** — PDF.js canvas API, high-DPI output, progress feedback, dual-page view, and adjacent-page prefetch
- **Annotations that stick** — freehand, highlighter, line/arrow, text notes, and music-symbol stamps stored in IndexedDB (Dexie)
- **Undo / redo** per page, eraser (strokes, symbols, and notes), move tool
- **Library** — one synced score folder (native desktop or browser File System Access), favorites, search, grid/list, sort filters
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
npm run portraits   # Again, only needed if public/composers/ is missing
npm run tauri:dev
```

```bash
npm run tauri:build
```

On Linux the build produces `.deb`, `.rpm`, and (when `SONORA_BUILD_APPIMAGE=1`) an AppImage. Prefer the native packages when available.

### Linux AppImage note

Older AppImages could crash on some Wayland / modern-Mesa systems with:

```text
Could not create default EGL display: EGL_BAD_PARAMETER. Aborting...
```

This is caused by over-bundled `libwayland-*` libraries conflicting with the host graphics stack. Recent CI builds strip those libraries so the AppImage uses the system ones instead.

If you still hit the error with an older AppImage, try:

```bash
WEBKIT_DISABLE_DMABUF_RENDERER=1 WEBKIT_DISABLE_COMPOSITING_MODE=1 ./Sonora_*.AppImage
```

or

```bash
LD_PRELOAD=/usr/lib/libwayland-client.so.0 ./Sonora_*.AppImage
```

(use `/usr/lib64/...` or the multiarch path on your distro if needed).

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

Svelte 5 · Vite · PDF.js · Dexie · Lucide · Tauri 2

## Contributing

Contributions are welcome. Simply open a PR.
