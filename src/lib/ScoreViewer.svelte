<script lang="ts">
  import { onMount, tick } from 'svelte';
  import * as pdfjsLib from 'pdfjs-dist';
  import {
    ArrowLeft, ChevronLeft, ChevronRight, Pencil, Highlighter, Eraser,
    Trash2, Sun, Moon, BookOpen, Columns, Square, ZoomIn, ZoomOut,
    RotateCcw, Undo, Redo, Music2, Type, Settings, Maximize2, Minimize2,
    X, Keyboard, PanelTop, MousePointer2
  } from 'lucide-svelte';
  import { db } from './db';
  import type { ScoreItem, Stroke, SymbolStamp, TextNote } from './types';

  let { score, onBack }: { score: ScoreItem; onBack: () => void } = $props();
  type Snapshot = { strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[] };
  type Tool = 'pen' | 'highlighter' | 'stamp' | 'text' | 'eraser';

  const MAX_CANVAS_PIXELS = 8_000_000;
  const MAX_ZOOM = 3;
  const MIN_ZOOM = 0.5;

  let pdfDoc = $state<pdfjsLib.PDFDocumentProxy | null>(null);
  let pdfUrl = $state<string | null>(null);
  let currentPage = $state(1);
  let totalPages = $state(score.totalPages || 0);
  let isDualPage = $state(false);
  let fitMode = $state<'height' | 'width' | 'page'>('height');
  let zoomLevel = $state(1);
  let filterMode = $state<'normal' | 'sepia' | 'dark'>('normal');
  let loading = $state(true);
  let error = $state('');
  let isFullscreen = $state(false);
  let showSettings = $state(false);
  let showShortcuts = $state(false);
  let showControls = $state(true);
  let isAnnotationToolOpen = $state(false);
  let activeTool = $state<Tool>('pen');
  let penColor = $state('#ef4444');
  let penWidth = $state(3);
  let selectedSymbol = $state('𝄐');
  let settingsDefaultFit = $state<'height' | 'width' | 'page'>('height');
  let settingsDualPage = $state(false);
  let settingsDarkScore = $state(false);

  let annotations = $state<Record<number, Stroke[]>>({});
  let stamps = $state<Record<number, SymbolStamp[]>>({});
  let notes = $state<Record<number, TextNote[]>>({});
  let historyStack = $state<Record<number, Snapshot[]>>({});
  let redoStack = $state<Record<number, Snapshot[]>>({});
  let drawing = $state<{ page: number; pointerId: number; canvas: HTMLCanvasElement; stroke: Stroke } | null>(null);
  let mainContainerRef = $state<HTMLDivElement | null>(null);
  let leftPdfCanvas = $state<HTMLCanvasElement | null>(null);
  let leftDrawCanvas = $state<HTMLCanvasElement | null>(null);
  let rightPdfCanvas = $state<HTMLCanvasElement | null>(null);
  let rightDrawCanvas = $state<HTMLCanvasElement | null>(null);
  let renderGeneration = 0;
  let resizeTimer: ReturnType<typeof setTimeout> | undefined;
  const saveQueue: Record<number, Promise<void>> = {};

  const QUICK_COLORS = ['#ef4444', '#3b82f6', '#10b981', '#eab308', '#a855f7', '#ffffff', '#000000'];
  const MUSICAL_SYMBOLS = [
    ['𝄐', 'Fermata'], ['♯', 'Sharp'], ['♭', 'Flat'], ['♮', 'Natural'], ['>', 'Accent'],
    ['•', 'Staccato'], ['ƒ', 'Forte'], ['p', 'Piano'], ['mƒ', 'Mezzo Forte'], ['mp', 'Mezzo Piano'],
    ['ff', 'Fortissimo'], ['pp', 'Pianissimo'], ['⨅', 'Down Bow'], ['⋁', 'Up Bow'], ['𝄋', 'Segno'],
    ['𝄌', 'Coda'], [',', 'Breath'], ['1', 'Finger 1'], ['2', 'Finger 2'], ['3', 'Finger 3'],
    ['4', 'Finger 4'], ['5', 'Finger 5']
  ];

  onMount(async () => {
    await tick();
    isDualPage = window.innerWidth >= 1100;
    settingsDualPage = isDualPage;
    settingsDefaultFit = fitMode;
    window.addEventListener('resize', scheduleRerender);
    document.addEventListener('fullscreenchange', handleFullscreenChange);

    try {
      pdfUrl = URL.createObjectURL(score.pdfBlob);
      const loadingTask = pdfjsLib.getDocument({
        url: pdfUrl,
        disableAutoFetch: false,
        disableStream: false,
        useSystemFonts: true,
        isEvalSupported: true
      });
      pdfDoc = await loadingTask.promise;
      totalPages = pdfDoc.numPages;

      const saved = await db.annotations.where('scoreId').equals(score.id).toArray();
      for (const record of saved) {
        annotations[record.pageNum] = record.strokes || [];
        stamps[record.pageNum] = record.stamps || [];
        notes[record.pageNum] = record.notes || [];
      }
      await renderPages();
    } catch (e) {
      console.error('PDF error:', e);
      error = e instanceof Error && e.message ? e.message : 'This score could not be opened. The PDF may be damaged or unsupported.';
    } finally {
      loading = false;
    }

    return () => {
      window.removeEventListener('resize', scheduleRerender);
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      if (resizeTimer) clearTimeout(resizeTimer);
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
      void pdfDoc?.destroy();
    };
  });

  function handleFullscreenChange() {
    isFullscreen = document.fullscreenElement !== null;
    void renderPages();
  }

  function scheduleRerender() {
    const nextDual = window.innerWidth >= 1100;
    if (nextDual !== isDualPage) isDualPage = nextDual;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => void renderPages(), 120);
  }

  function snapshot(page: number): Snapshot {
    return {
      strokes: structuredClone(annotations[page] || []),
      stamps: structuredClone(stamps[page] || []),
      notes: structuredClone(notes[page] || [])
    };
  }

  function snapshotsEqual(a: Snapshot, b: Snapshot) {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  function pushHistory(page: number, before: Snapshot) {
    if (!historyStack[page]) historyStack[page] = [];
    historyStack[page].push(before);
    if (historyStack[page].length > 80) historyStack[page].shift();
    redoStack[page] = [];
  }

  function persist(page: number): Promise<void> {
    const previous = saveQueue[page] || Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      await db.annotations.put({
        id: `${score.id}_page_${page}`,
        scoreId: score.id,
        pageNum: page,
        strokes: structuredClone(annotations[page] || []),
        stamps: structuredClone(stamps[page] || []),
        notes: structuredClone(notes[page] || [])
      });
    });
    saveQueue[page] = next;
    return next;
  }

  async function undo(page: number) {
    const stack = historyStack[page];
    if (!stack?.length) return;
    if (!redoStack[page]) redoStack[page] = [];
    redoStack[page].push(snapshot(page));
    const previous = stack.pop()!;
    annotations[page] = previous.strokes;
    stamps[page] = previous.stamps;
    notes[page] = previous.notes;
    await persist(page);
    redrawForPage(page);
  }

  async function redo(page: number) {
    const stack = redoStack[page];
    if (!stack?.length) return;
    if (!historyStack[page]) historyStack[page] = [];
    historyStack[page].push(snapshot(page));
    const next = stack.pop()!;
    annotations[page] = next.strokes;
    stamps[page] = next.stamps;
    notes[page] = next.notes;
    await persist(page);
    redrawForPage(page);
  }

  async function clearPage(page: number) {
    const before = snapshot(page);
    if (!before.strokes.length && !before.stamps.length && !before.notes.length) return;
    pushHistory(page, before);
    annotations[page] = [];
    stamps[page] = [];
    notes[page] = [];
    await persist(page);
    redrawForPage(page);
  }

  async function renderPages() {
    if (!pdfDoc || !mainContainerRef || totalPages < 1) return;
    const generation = ++renderGeneration;
    await renderSinglePage(currentPage, leftPdfCanvas, leftDrawCanvas, generation);
    if (generation !== renderGeneration) return;
    if (isDualPage && currentPage + 1 <= totalPages) {
      await renderSinglePage(currentPage + 1, rightPdfCanvas, rightDrawCanvas, generation);
    }
  }

  function calculateScale(page: pdfjsLib.PDFPageProxy) {
    const baseViewport = page.getViewport({ scale: 1 });
    const horizontalPadding = isDualPage ? 120 : 72;
    const width = Math.max(260, (mainContainerRef!.clientWidth - horizontalPadding) / (isDualPage ? 2 : 1));
    const height = Math.max(260, mainContainerRef!.clientHeight - 72);
    let scale = height / baseViewport.height;
    if (fitMode === 'width') scale = width / baseViewport.width;
    if (fitMode === 'page') scale = Math.min(width / baseViewport.width, height / baseViewport.height);
    return Math.max(0.08, Math.min(4, scale * zoomLevel));
  }

  async function renderSinglePage(pageNum: number, pdfCanvas: HTMLCanvasElement | null, drawCanvas: HTMLCanvasElement | null, generation: number) {
    if (!pdfDoc || !pdfCanvas || !drawCanvas || !mainContainerRef) return;
    const page = await pdfDoc.getPage(pageNum);
    if (generation !== renderGeneration) return;

    const cssScale = calculateScale(page);
    const viewport = page.getViewport({ scale: cssScale });
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const pixelBudgetScale = Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, viewport.width * viewport.height));
    const outputScale = Math.max(0.5, Math.min(dpr, pixelBudgetScale));
    const renderViewport = page.getViewport({ scale: cssScale * outputScale });

    pdfCanvas.width = Math.ceil(renderViewport.width);
    pdfCanvas.height = Math.ceil(renderViewport.height);
    drawCanvas.width = pdfCanvas.width;
    drawCanvas.height = pdfCanvas.height;
    pdfCanvas.style.width = `${viewport.width}px`;
    pdfCanvas.style.height = `${viewport.height}px`;
    drawCanvas.style.width = `${viewport.width}px`;
    drawCanvas.style.height = `${viewport.height}px`;

    const ctx = pdfCanvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, pdfCanvas.width, pdfCanvas.height);
    await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
    if (generation !== renderGeneration) return;

    migrateLegacyAnnotations(pageNum, pdfCanvas.width, pdfCanvas.height);
    redrawOverlay(pageNum, drawCanvas);
  }

  function migrateLegacyAnnotations(page: number, width: number, height: number) {
    const strokes = annotations[page] || [];
    const hasLegacyStroke = strokes.some(stroke => stroke.points.some(point => point.x > 1 || point.y > 1));
    const hasLegacyStamp = (stamps[page] || []).some(stamp => stamp.x > 1 || stamp.y > 1);
    const hasLegacyNote = (notes[page] || []).some(note => note.x > 1 || note.y > 1);
    if (!hasLegacyStroke && !hasLegacyStamp && !hasLegacyNote) return;

    annotations[page] = strokes.map(stroke => ({
      ...stroke,
      points: stroke.points.map(point => ({ x: point.x / width, y: point.y / height }))
    }));
    stamps[page] = (stamps[page] || []).map(stamp => ({ ...stamp, x: stamp.x / width, y: stamp.y / height }));
    notes[page] = (notes[page] || []).map(note => ({ ...note, x: note.x / width, y: note.y / height }));
    void persist(page);
  }

  function redrawForPage(page: number) {
    if (page === currentPage) redrawOverlay(page, leftDrawCanvas);
    if (isDualPage && page === currentPage + 1) redrawOverlay(page, rightDrawCanvas);
  }

  function toCanvasPoint(point: { x: number; y: number }, canvas: HTMLCanvasElement) {
    return { x: point.x * canvas.width, y: point.y * canvas.height };
  }

  function drawStroke(ctx: CanvasRenderingContext2D, canvas: HTMLCanvasElement, stroke: Stroke) {
    if (!stroke.points.length) return;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = stroke.tool === 'highlighter' ? 'rgba(250,204,21,.38)' : stroke.color;
    ctx.fillStyle = ctx.strokeStyle;
    ctx.lineWidth = stroke.tool === 'highlighter' ? Math.max(12, stroke.width * 5) : stroke.width;
    const first = toCanvasPoint(stroke.points[0], canvas);
    if (stroke.points.length === 1) {
      ctx.beginPath();
      ctx.arc(first.x, first.y, Math.max(1.5, ctx.lineWidth / 2), 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(first.x, first.y);
      for (let i = 1; i < stroke.points.length; i++) {
        const point = toCanvasPoint(stroke.points[i], canvas);
        ctx.lineTo(point.x, point.y);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function redrawOverlay(page: number, canvas: HTMLCanvasElement | null) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of annotations[page] || []) drawStroke(ctx, canvas, stroke);
    for (const stamp of stamps[page] || []) {
      const point = toCanvasPoint(stamp, canvas);
      ctx.save();
      ctx.font = `${stamp.fontSize * Math.max(0.75, canvas.width / Math.max(1, canvas.clientWidth))}px serif`;
      ctx.fillStyle = stamp.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(stamp.symbol, point.x, point.y);
      ctx.restore();
    }
    for (const note of notes[page] || []) {
      const point = toCanvasPoint(note, canvas);
      ctx.save();
      ctx.font = `600 ${note.fontSize * Math.max(0.75, canvas.width / Math.max(1, canvas.clientWidth))}px sans-serif`;
      ctx.fillStyle = note.color;
      ctx.fillText(note.text, point.x, point.y);
      ctx.restore();
    }
    if (drawing?.page === page && drawing.canvas === canvas) drawStroke(ctx, canvas, drawing.stroke);
  }

  function pointFor(event: PointerEvent, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    return {
      x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
      y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height))
    };
  }

  async function addStamp(page: number, x: number, y: number) {
    const before = snapshot(page);
    if (!stamps[page]) stamps[page] = [];
    stamps[page].push({ id: crypto.randomUUID(), symbol: selectedSymbol, label: 'stamp', x, y, fontSize: 32, color: penColor });
    pushHistory(page, before);
    redrawForPage(page);
    await persist(page);
  }

  async function addText(page: number, x: number, y: number) {
    const text = prompt('Enter rehearsal note / instruction:');
    if (!text?.trim()) return;
    const before = snapshot(page);
    if (!notes[page]) notes[page] = [];
    notes[page].push({ id: crypto.randomUUID(), text: text.trim(), x, y, fontSize: 16, color: penColor });
    pushHistory(page, before);
    redrawForPage(page);
    await persist(page);
  }

  async function eraseAt(page: number, x: number, y: number, canvas: HTMLCanvasElement) {
    const radius = Math.max(18 / canvas.width, penWidth * 5 / canvas.width);
    const before = snapshot(page);
    annotations[page] = (annotations[page] || []).filter(stroke => !stroke.points.some(point => Math.hypot(point.x - x, point.y - y) <= radius));
    stamps[page] = (stamps[page] || []).filter(stamp => Math.hypot(stamp.x - x, stamp.y - y) > radius + 14 / canvas.width);
    notes[page] = (notes[page] || []).filter(note => Math.hypot(note.x - x, note.y - y) > radius + 14 / canvas.width);
    const after = snapshot(page);
    if (snapshotsEqual(before, after)) return;
    pushHistory(page, before);
    redrawOverlay(page, canvas);
    await persist(page);
  }

  function pointerDown(event: PointerEvent, page: number, canvas: HTMLCanvasElement) {
    if (!isAnnotationToolOpen || event.button !== 0) return;
    event.preventDefault();
    const point = pointFor(event, canvas);
    if (activeTool === 'stamp') { void addStamp(page, point.x, point.y); return; }
    if (activeTool === 'text') { void addText(page, point.x, point.y); return; }
    if (activeTool === 'eraser') {
      canvas.setPointerCapture(event.pointerId);
      void eraseAt(page, point.x, point.y, canvas);
      return;
    }
    const stroke: Stroke = { tool: activeTool, color: penColor, width: penWidth, points: [point] };
    drawing = { page, pointerId: event.pointerId, canvas, stroke };
    canvas.setPointerCapture(event.pointerId);
    redrawOverlay(page, canvas);
  }

  function pointerMove(event: PointerEvent, page: number, canvas: HTMLCanvasElement) {
    if (activeTool === 'eraser') {
      if (!canvas.hasPointerCapture(event.pointerId)) return;
      const point = pointFor(event, canvas);
      void eraseAt(page, point.x, point.y, canvas);
      return;
    }
    if (!drawing || drawing.page !== page || drawing.canvas !== canvas || drawing.pointerId !== event.pointerId) return;
    drawing.stroke.points.push(pointFor(event, canvas));
    redrawOverlay(page, canvas);
  }

  async function finishDrawing(event: PointerEvent, page: number, canvas: HTMLCanvasElement) {
    if (!drawing || drawing.page !== page || drawing.canvas !== canvas || drawing.pointerId !== event.pointerId) return;
    const active = drawing;
    drawing = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    const before = snapshot(page);
    if (!annotations[page]) annotations[page] = [];
    annotations[page].push(active.stroke);
    pushHistory(page, before);
    redrawOverlay(page, canvas);
    await persist(page);
  }

  function cancelDrawing(event: PointerEvent, page: number, canvas: HTMLCanvasElement) {
    if (!drawing || drawing.page !== page || drawing.canvas !== canvas || drawing.pointerId !== event.pointerId) return;
    drawing = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
    redrawOverlay(page, canvas);
  }

  function goToPage(page: number) {
    const target = Math.max(1, Math.min(totalPages, Math.floor(Number(page) || 1)));
    if (target === currentPage) return;
    drawing = null;
    currentPage = target;
    void renderPages();
  }

  function nextPage() { goToPage(currentPage + (isDualPage ? 2 : 1)); }
  function previousPage() { goToPage(currentPage - (isDualPage ? 2 : 1)); }

  async function toggleFullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch (e) {
      console.warn('Fullscreen unavailable:', e);
    }
  }

  function setZoom(value: number) {
    zoomLevel = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, value));
    void renderPages();
  }

  function handleWheel(event: WheelEvent) {
    if (!event.ctrlKey && !event.metaKey) return;
    event.preventDefault();
    setZoom(zoomLevel + (event.deltaY < 0 ? 0.1 : -0.1));
  }

  function handleKeyDown(event: KeyboardEvent) {
    const target = event.target as HTMLElement | null;
    if (target && ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)) return;
    if (event.key === 'Escape') {
      if (showSettings || showShortcuts) { showSettings = false; showShortcuts = false; return; }
      if (isFullscreen) { void document.exitFullscreen(); return; }
    }
    if (event.key === 'ArrowRight' || event.key === 'PageDown') { event.preventDefault(); nextPage(); }
    if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); previousPage(); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); void undo(currentPage); }
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); void redo(currentPage); }
    if (event.key.toLowerCase() === 'p') { isAnnotationToolOpen = true; activeTool = 'pen'; }
    if (event.key.toLowerCase() === 'h') { isAnnotationToolOpen = true; activeTool = 'highlighter'; }
    if (event.key.toLowerCase() === 's') { isAnnotationToolOpen = true; activeTool = 'stamp'; }
    if (event.key.toLowerCase() === 't') { isAnnotationToolOpen = true; activeTool = 'text'; }
    if (event.key.toLowerCase() === 'e') { isAnnotationToolOpen = true; activeTool = 'eraser'; }
    if (event.key === '+') setZoom(zoomLevel + 0.1);
    if (event.key === '-') setZoom(zoomLevel - 0.1);
    if (event.key === '0') { zoomLevel = 1; fitMode = 'height'; void renderPages(); }
    if (event.key === ' ') { event.preventDefault(); nextPage(); }
  }

  function applySettings() {
    fitMode = settingsDefaultFit;
    isDualPage = settingsDualPage;
    filterMode = settingsDarkScore ? 'dark' : 'normal';
    showSettings = false;
    void renderPages();
  }

  function currentPageHasAnnotations(page: number) {
    return Boolean(annotations[page]?.length || stamps[page]?.length || notes[page]?.length);
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

<div class="viewer-shell flex-1 flex flex-col relative bg-neutral-950 text-neutral-100 overflow-hidden select-none">
  {#if showControls}
    <header class="viewer-header h-14 shrink-0 flex items-center justify-between gap-3 px-3 sm:px-5 bg-neutral-900/90 backdrop-blur-2xl border-b border-neutral-800/80 z-30">
      <div class="flex items-center gap-2 min-w-0">
        <button onclick={onBack} class="icon-button" title="Back to library"><ArrowLeft size={18}/></button>
        <div class="min-w-0 hidden sm:block"><div class="text-sm font-semibold truncate max-w-72">{score.title}</div><div class="text-[11px] text-neutral-500 truncate">{score.composer}</div></div>
      </div>
      <div class="flex items-center gap-1.5">
        <button onclick={previousPage} disabled={currentPage <= 1} class="icon-button" title="Previous page"><ChevronLeft size={18}/></button>
        <label class="page-control"><input aria-label="Page number" type="number" min="1" max={totalPages} value={currentPage} onchange={(e) => goToPage(Number((e.currentTarget as HTMLInputElement).value))}/><span>/ {totalPages}</span></label>
        <button onclick={nextPage} disabled={currentPage >= totalPages} class="icon-button" title="Next page"><ChevronRight size={18}/></button>
      </div>
      <div class="flex items-center gap-1.5">
        <div class="hidden lg:flex items-center bg-neutral-950/80 border border-neutral-800 rounded-xl p-0.5">
          <button onclick={() => setZoom(zoomLevel - .1)} class="mini-button" title="Zoom out"><ZoomOut size={15}/></button>
          <span class="text-[11px] font-mono w-11 text-center text-neutral-300">{Math.round(zoomLevel * 100)}%</span>
          <button onclick={() => setZoom(zoomLevel + .1)} class="mini-button" title="Zoom in"><ZoomIn size={15}/></button>
          <button onclick={() => { zoomLevel = 1; fitMode = 'height'; void renderPages(); }} class="mini-button border-l border-neutral-800 ml-0.5" title="Reset zoom"><RotateCcw size={14}/></button>
        </div>
        <button onclick={() => isAnnotationToolOpen = !isAnnotationToolOpen} class="icon-button {isAnnotationToolOpen ? 'active-blue' : ''}" title="Annotations"><Pencil size={17}/></button>
        <button onclick={() => { isDualPage = !isDualPage; void renderPages(); }} class="icon-button hidden sm:flex" title="Facing pages">{#if isDualPage}<Columns size={17}/>{:else}<Square size={17}/>{/if}</button>
        <button onclick={() => showSettings = true} class="icon-button" title="Viewer settings"><Settings size={17}/></button>
      </div>
    </header>
  {/if}

  {#if isAnnotationToolOpen}
    <div class="annotation-bar absolute top-[4.25rem] left-1/2 -translate-x-1/2 z-40 max-w-[calc(100%-1rem)] bg-neutral-900/95 backdrop-blur-2xl border border-neutral-700/80 rounded-2xl shadow-2xl p-2">
      <div class="flex flex-wrap items-center justify-center gap-1.5">
        <button onclick={() => activeTool = 'pen'} class="tool {activeTool === 'pen' ? 'active-blue' : ''}" title="Pen (P)"><Pencil size={16}/></button>
        <button onclick={() => activeTool = 'highlighter'} class="tool {activeTool === 'highlighter' ? 'active-yellow' : ''}" title="Highlighter (H)"><Highlighter size={16}/></button>
        <button onclick={() => activeTool = 'eraser'} class="tool {activeTool === 'eraser' ? 'active-neutral' : ''}" title="Eraser (E)"><Eraser size={16}/></button>
        <button onclick={() => activeTool = 'stamp'} class="tool {activeTool === 'stamp' ? 'active-purple' : ''}" title="Musical symbol (S)"><Music2 size={16}/></button>
        <button onclick={() => activeTool = 'text'} class="tool {activeTool === 'text' ? 'active-green' : ''}" title="Text note (T)"><Type size={16}/></button>
        <span class="separator"></span>
        {#each QUICK_COLORS as color}<button onclick={() => penColor = color} class="color-dot {penColor === color ? 'selected' : ''}" style={`background:${color}`} aria-label={`Set color ${color}`}></button>{/each}
        <label class="size-control"><span>Size</span><input type="range" min="1" max="12" bind:value={penWidth}/></label>
        <span class="separator"></span>
        <button onclick={() => void undo(currentPage)} disabled={!historyStack[currentPage]?.length} class="tool" title="Undo"><Undo size={16}/></button>
        <button onclick={() => void redo(currentPage)} disabled={!redoStack[currentPage]?.length} class="tool" title="Redo"><Redo size={16}/></button>
        <button onclick={() => void clearPage(currentPage)} disabled={!currentPageHasAnnotations(currentPage)} class="tool hover-danger" title="Clear page"><Trash2 size={16}/></button>
      </div>
      {#if activeTool === 'stamp'}<div class="symbol-row">{#each MUSICAL_SYMBOLS as item}<button onclick={() => selectedSymbol = item[0]} class="symbol-button {selectedSymbol === item[0] ? 'symbol-selected' : ''}" title={item[1]}>{item[0]}</button>{/each}</div>{/if}
    </div>
  {/if}

  <main bind:this={mainContainerRef} onwheel={handleWheel} class="relative flex-1 overflow-auto flex items-center justify-center p-3 sm:p-5 bg-[radial-gradient(circle_at_center,_#202020_0,_#111_42%,_#0a0a0a_100%)]">
    {#if loading}
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-neutral-500 bg-neutral-950 z-20"><div class="loading-ring"></div><span>Opening score…</span></div>
    {:else if error}
      <div class="max-w-md text-center p-8 rounded-3xl bg-neutral-900/90 border border-neutral-800 shadow-2xl"><div class="text-red-400 font-semibold mb-2">Unable to open score</div><p class="text-sm text-neutral-500 mb-5">{error}</p><button onclick={onBack} class="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm">Return to library</button></div>
    {:else}
      <button onclick={previousPage} disabled={currentPage <= 1 || isAnnotationToolOpen} class="page-zone left-zone"><ChevronLeft size={34}/></button>
      <button onclick={nextPage} disabled={currentPage >= totalPages || isAnnotationToolOpen} class="page-zone right-zone"><ChevronRight size={34}/></button>
      <div class="flex gap-4 items-center justify-center max-w-full min-h-0">
        <div class="score-page">
          <canvas bind:this={leftPdfCanvas} class="block {filterMode === 'sepia' ? 'sepia contrast-105 brightness-95' : ''} {filterMode === 'dark' ? 'invert hue-rotate-180 contrast-125' : ''}"></canvas>
          <canvas bind:this={leftDrawCanvas} onpointerdown={(e) => pointerDown(e, currentPage, e.currentTarget as HTMLCanvasElement)} onpointermove={(e) => pointerMove(e, currentPage, e.currentTarget as HTMLCanvasElement)} onpointerup={(e) => void finishDrawing(e, currentPage, e.currentTarget as HTMLCanvasElement)} onpointercancel={(e) => cancelDrawing(e, currentPage, e.currentTarget as HTMLCanvasElement)} class="absolute inset-0 touch-none {isAnnotationToolOpen ? 'cursor-crosshair' : 'pointer-events-none'}"></canvas>
        </div>
        {#if isDualPage && currentPage + 1 <= totalPages}
          <div class="score-page">
            <canvas bind:this={rightPdfCanvas} class="block {filterMode === 'sepia' ? 'sepia contrast-105 brightness-95' : ''} {filterMode === 'dark' ? 'invert hue-rotate-180 contrast-125' : ''}"></canvas>
            <canvas bind:this={rightDrawCanvas} onpointerdown={(e) => pointerDown(e, currentPage + 1, e.currentTarget as HTMLCanvasElement)} onpointermove={(e) => pointerMove(e, currentPage + 1, e.currentTarget as HTMLCanvasElement)} onpointerup={(e) => void finishDrawing(e, currentPage + 1, e.currentTarget as HTMLCanvasElement)} onpointercancel={(e) => cancelDrawing(e, currentPage + 1, e.currentTarget as HTMLCanvasElement)} class="absolute inset-0 touch-none {isAnnotationToolOpen ? 'cursor-crosshair' : 'pointer-events-none'}"></canvas>
          </div>
        {/if}
      </div>
    {/if}
  </main>

  {#if showControls}
    <footer class="h-12 shrink-0 flex items-center justify-between gap-3 px-3 sm:px-5 bg-neutral-900/90 backdrop-blur-2xl border-t border-neutral-800/80 z-30 text-[11px] text-neutral-500">
      <div class="hidden md:block truncate max-w-[30%]">{score.composer} · {score.title}</div>
      <div class="flex items-center gap-1 bg-neutral-950/80 border border-neutral-800 rounded-xl p-0.5"><button onclick={() => { fitMode = 'height'; void renderPages(); }} class="fit-button {fitMode === 'height' ? 'selected' : ''}">Fit height</button><button onclick={() => { fitMode = 'width'; void renderPages(); }} class="fit-button {fitMode === 'width' ? 'selected' : ''}">Fit width</button><button onclick={() => { fitMode = 'page'; void renderPages(); }} class="fit-button {fitMode === 'page' ? 'selected' : ''}">Fit page</button></div>
      <div class="flex items-center gap-1"><button onclick={() => filterMode = 'normal'} class="footer-icon {filterMode === 'normal' ? 'selected' : ''}" title="Normal page"><Sun size={14}/></button><button onclick={() => filterMode = 'sepia'} class="footer-icon {filterMode === 'sepia' ? 'selected-amber' : ''}" title="Warm page"><BookOpen size={14}/></button><button onclick={() => filterMode = 'dark'} class="footer-icon {filterMode === 'dark' ? 'selected' : ''}" title="Dark page"><Moon size={14}/></button><button onclick={() => void toggleFullscreen()} class="footer-icon hidden sm:flex" title="Fullscreen">{#if isFullscreen}<Minimize2 size={14}/>{:else}<Maximize2 size={14}/>{/if}</button></div>
    </footer>
  {/if}

  <button onclick={() => showControls = !showControls} class="shell-toggle" title="Toggle controls"><PanelTop size={15}/></button>

  {#if showSettings}
    <div class="modal-backdrop" role="presentation" onclick={(e) => e.currentTarget === e.target && (showSettings = false)}>
      <section class="settings-panel" role="dialog" aria-modal="true" aria-label="Viewer settings">
        <div class="flex items-center justify-between mb-5"><div><h2 class="text-lg font-semibold">Viewer settings</h2><p class="text-xs text-neutral-500 mt-1">Tune Sonora for the way you read and mark music.</p></div><button onclick={() => showSettings = false} class="icon-button"><X size={18}/></button></div>
        <div class="space-y-5">
          <div><p class="setting-label">Default page fit</p><div class="setting-segment"><button onclick={() => settingsDefaultFit = 'height'} class:chosen={settingsDefaultFit === 'height'}>Height</button><button onclick={() => settingsDefaultFit = 'page'} class:chosen={settingsDefaultFit === 'page'}>Page</button><button onclick={() => settingsDefaultFit = 'width'} class:chosen={settingsDefaultFit === 'width'}>Width</button></div></div>
          <label class="setting-row"><span><strong>Facing pages</strong><small>Show two pages when space allows.</small></span><input type="checkbox" bind:checked={settingsDualPage}/></label>
          <label class="setting-row"><span><strong>Dark score</strong><small>Invert the page for low-light reading.</small></span><input type="checkbox" bind:checked={settingsDarkScore}/></label>
          <div class="setting-card"><div class="flex items-center gap-2 text-neutral-300"><MousePointer2 size={16}/><span class="font-medium">Stable annotations</span></div><p>Annotations use page-relative coordinates, so marks stay attached to the music when you zoom, resize the window, or switch between single and facing-page views.</p></div>
          <button onclick={() => { showSettings = false; showShortcuts = true; }} class="setting-row w-full text-left"><span><strong>Keyboard shortcuts</strong><small>Page turns, annotation tools, zoom, undo and redo.</small></span><Keyboard size={17} class="text-neutral-500"/></button>
        </div>
        <div class="flex justify-end gap-2 mt-6"><button onclick={() => showSettings = false} class="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm">Cancel</button><button onclick={applySettings} class="px-4 py-2 rounded-xl bg-blue-600 hover:bg-blue-500 text-sm font-medium">Apply</button></div>
      </section>
    </div>
  {/if}

  {#if showShortcuts}
    <div class="modal-backdrop" role="presentation" onclick={(e) => e.currentTarget === e.target && (showShortcuts = false)}>
      <section class="settings-panel max-w-md" role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"><div class="flex items-center justify-between mb-5"><h2 class="text-lg font-semibold">Keyboard shortcuts</h2><button onclick={() => showShortcuts = false} class="icon-button"><X size={18}/></button></div><div class="shortcut-list"><div><span>Next / previous page</span><kbd>←</kbd><kbd>→</kbd></div><div><span>Next page</span><kbd>Space</kbd></div><div><span>Pen / highlighter</span><kbd>P</kbd><kbd>H</kbd></div><div><span>Symbol / text / eraser</span><kbd>S</kbd><kbd>T</kbd><kbd>E</kbd></div><div><span>Zoom</span><kbd>+</kbd><kbd>−</kbd><kbd>Ctrl + wheel</kbd></div><div><span>Undo / redo</span><kbd>Ctrl/Cmd Z</kbd><kbd>Ctrl/Cmd Y</kbd></div><div><span>Reset view</span><kbd>0</kbd></div><div><span>Close dialog / fullscreen</span><kbd>Esc</kbd></div></div></section>
    </div>
  {/if}
</div>

<style>
  .viewer-shell{font-family:Inter,ui-sans-serif,system-ui,sans-serif}.icon-button,.mini-button,.tool,.footer-icon,.fit-button{transition:all .16s ease}.icon-button{width:36px;height:36px;display:flex;align-items:center;justify-content:center;border-radius:11px;color:#a3a3a3;background:rgba(23,23,23,.78);border:1px solid #262626}.icon-button:hover:not(:disabled),.mini-button:hover:not(:disabled),.footer-icon:hover{color:#fff;background:#262626}.icon-button:disabled,.mini-button:disabled,.tool:disabled{opacity:.3;cursor:not-allowed}.active-blue{color:#bfdbfe!important;background:rgba(37,99,235,.22)!important;border-color:rgba(59,130,246,.55)!important}.active-yellow{color:#fde68a!important;background:rgba(234,179,8,.16)!important;border-color:rgba(234,179,8,.45)!important}.active-purple{color:#ddd6fe!important;background:rgba(124,58,237,.2)!important;border-color:rgba(139,92,246,.5)!important}.active-green{color:#a7f3d0!important;background:rgba(16,185,129,.16)!important;border-color:rgba(16,185,129,.45)!important}.active-neutral{color:#fff!important;background:#303030!important}.mini-button{width:30px;height:28px;display:flex;align-items:center;justify-content:center;color:#a3a3a3;border-radius:8px}.page-control{display:flex;align-items:center;justify-content:center;gap:4px;min-width:76px;color:#737373;font-size:11px}.page-control input{width:38px;text-align:center;background:#0a0a0a;color:#e5e5e5;border:1px solid #262626;border-radius:8px;padding:5px 3px;outline:none}.page-control input:focus{border-color:#3b82f6}.annotation-bar{animation:slide-down .18s ease-out}.tool{width:34px;height:34px;display:flex;align-items:center;justify-content:center;border-radius:10px;color:#a3a3a3;background:#171717;border:1px solid #262626}.tool:hover:not(:disabled){color:#fff;background:#262626}.hover-danger:hover{color:#fca5a5;border-color:rgba(239,68,68,.35)}.separator{width:1px;height:23px;background:#303030;margin:0 3px}.color-dot{width:20px;height:20px;border-radius:999px;border:2px solid #404040;transition:transform .15s ease,border-color .15s ease,box-shadow .15s ease}.color-dot:hover{transform:scale(1.12)}.color-dot.selected{border-color:#fff;box-shadow:0 0 0 2px #3b82f6;transform:scale(1.08)}.size-control{display:flex;align-items:center;gap:6px;padding:0 4px;color:#a3a3a3;font-size:11px}.size-control input{width:70px;accent-color:#3b82f6}.symbol-row{display:flex;gap:5px;overflow-x:auto;padding-top:8px;margin-top:7px;border-top:1px solid #292929}.symbol-button{min-width:34px;height:31px;padding:0 8px;border-radius:9px;border:1px solid #292929;background:#0a0a0a;color:#d4d4d4;font-family:serif;transition:.15s ease}.symbol-button:hover{background:#262626}.symbol-selected{color:#ddd6fe;background:rgba(124,58,237,.2);border-color:#8b5cf6}.score-page{position:relative;background:#fff;box-shadow:0 18px 55px rgba(0,0,0,.5),0 3px 12px rgba(0,0,0,.35);border-radius:2px;overflow:hidden;flex:none;animation:page-enter .2s ease-out}.page-zone{position:absolute;top:0;bottom:0;width:13%;z-index:10;display:flex;align-items:center;color:rgba(255,255,255,.55);opacity:0;transition:opacity .16s ease,background .16s ease}.page-zone:hover:not(:disabled){opacity:1}.left-zone{left:0;justify-content:flex-start;padding-left:12px;background:linear-gradient(90deg,rgba(10,10,10,.55),transparent)}.right-zone{right:0;justify-content:flex-end;padding-right:12px;background:linear-gradient(270deg,rgba(10,10,10,.55),transparent)}.page-zone:disabled{pointer-events:none}.fit-button{padding:6px 9px;border-radius:8px;color:#737373}.fit-button:hover{color:#d4d4d4}.fit-button.selected{color:#e5e5e5;background:#262626}.footer-icon{width:29px;height:29px;display:flex;align-items:center;justify-content:center;border-radius:8px;color:#737373}.footer-icon.selected{color:#e5e5e5;background:#262626}.footer-icon.selected-amber{color:#fde68a;background:rgba(120,53,15,.45)}.shell-toggle{position:absolute;right:10px;bottom:59px;z-index:45;width:28px;height:28px;border-radius:9px;background:rgba(23,23,23,.8);border:1px solid #303030;color:#737373;display:flex;align-items:center;justify-content:center;opacity:.55;transition:.15s ease}.shell-toggle:hover{opacity:1;color:#fff}.modal-backdrop{position:absolute;inset:0;z-index:60;display:flex;align-items:flex-start;justify-content:flex-end;padding:16px;background:rgba(0,0,0,.58);backdrop-filter:blur(6px);animation:fade-in .16s ease-out}.settings-panel{width:min(100%,420px);margin-top:42px;padding:20px;border:1px solid #3a3a3a;border-radius:20px;background:rgba(23,23,23,.97);box-shadow:0 24px 80px rgba(0,0,0,.55);animation:panel-enter .2s ease-out}.setting-label{font-size:11px;color:#737373;margin-bottom:8px;text-transform:uppercase;letter-spacing:.08em}.setting-segment{display:grid;grid-template-columns:repeat(3,1fr);gap:4px;padding:4px;background:#0a0a0a;border:1px solid #292929;border-radius:11px}.setting-segment button{padding:8px;border-radius:8px;color:#737373;font-size:12px;transition:.15s ease}.setting-segment button:hover{color:#d4d4d4}.setting-segment button.chosen{color:#dbeafe;background:#1d4ed8}.setting-row{display:flex;align-items:center;justify-content:space-between;gap:14px;padding:12px 0;border-bottom:1px solid #292929}.setting-row strong{display:block;color:#e5e5e5;font-size:13px;font-weight:600}.setting-row small{display:block;color:#737373;font-size:11px;margin-top:3px}.setting-row input[type='checkbox']{width:17px;height:17px;accent-color:#2563eb}.setting-card{padding:12px;border:1px solid #292929;background:#101010;border-radius:13px}.setting-card p{color:#737373;font-size:11px;line-height:1.6;margin-top:7px}.shortcut-list{display:flex;flex-direction:column;gap:10px}.shortcut-list>div{display:flex;align-items:center;gap:5px;padding:9px 0;border-bottom:1px solid #292929;color:#a3a3a3;font-size:12px}.shortcut-list>div span{flex:1}kbd{padding:3px 7px;border-radius:6px;border:1px solid #404040;background:#0a0a0a;color:#d4d4d4;font:10px ui-monospace,SFMono-Regular,monospace}.loading-ring{width:25px;height:25px;border:2px solid #333;border-top-color:#60a5fa;border-radius:999px;animation:spin .8s linear infinite}@keyframes spin{to{transform:rotate(360deg)}@media (prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001ms!important;transition-duration:.001ms!important}}
</style>
