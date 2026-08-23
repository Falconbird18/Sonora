# Sonora

A web-based sheet music viewer built with Svelte 5, Vite, and PDF.js.

Import PDF scores, browse by composer, and annotate with pen, highlighter, lines, arrows, text notes, and musical symbols (SMuFL via Leland).

## Features

- **Reliable PDF rendering** — PDF.js v6 canvas API, high-DPI output, progress feedback, and dual-page view
- **Annotations that stick** — freehand, highlighter, line/arrow, text notes, and music-symbol stamps stored in IndexedDB (Dexie)
- **Stylus pressure** for natural pen weight
- **Undo / redo** per page, eraser, move tool
- **Library** — folder import (composer = parent folder), favorites, search, grid/list, sort filters
- **Focus mode** (`F`), keyboard page turns, thumbnail strip

## Develop

```bash
npm install
npm run dev
```

```bash
npm run build
npm run preview
```

## Fonts

Musical symbols use **Leland** (SIL OFL) from [MuseScoreFonts/Leland](https://github.com/MuseScoreFonts/Leland). Place `Leland.otf` in `public/fonts/` (included when available).

## Stack

Svelte 5 · Vite 8 · Tailwind CSS 4 · PDF.js · Dexie · Lucide
