<script lang="ts">
  import { onMount } from 'svelte';
  import * as pdfjsLib from 'pdfjs-dist';
  import {
    ArrowLeft, ChevronLeft, ChevronRight, Pencil, Highlighter, Eraser,
    Trash2, Sun, Moon, BookOpen, Columns, Square, ZoomIn, ZoomOut,
    RotateCcw, Undo, Redo, Music2, Type, Palette, Maximize2
  } from 'lucide-svelte';
  import { db } from './db';
  import type { ScoreItem, Stroke, SymbolStamp, TextNote } from './types';

  let { score, onBack }: { score: ScoreItem; onBack: () => void } = $props();

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

  let isAnnotationToolOpen = $state(false);
  let activeTool = $state<'pen' | 'highlighter' | 'stamp' | 'text' | 'eraser'>('pen');
  let penColor = $state('#ef4444');
  let penWidth = $state(3);
  let selectedSymbol = $state('𝄐');

  let annotations = $state<Record<number, Stroke[]>>({});
  let stamps = $state<Record<number, SymbolStamp[]>>({});
  let notes = $state<Record<number, TextNote[]>>({});
  let historyStack = $state<Record<number, { strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[] }[]>>({});
  let redoStack = $state<Record<number, { strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[] }[]>>({});

  let drawing = $state<{ page: number; pointerId: number; canvas: HTMLCanvasElement; stroke: Stroke } | null>(null);
  let mainContainerRef = $state<HTMLDivElement | null>(null);
  let leftPdfCanvas = $state<HTMLCanvasElement | null>(null);
  let leftDrawCanvas = $state<HTMLCanvasElement | null>(null);
  let rightPdfCanvas = $state<HTMLCanvasElement | null>(null);
  let rightDrawCanvas = $state<HTMLCanvasElement | null>(null);
  let renderGeneration = 0;

  const QUICK_COLORS = ['#ef4444', '#3b82f6', '#10b981', '#eab308', '#a855f7', '#ffffff', '#000000'];
  const MUSICAL_SYMBOLS = [
    ['𝄐', 'Fermata'], ['♯', 'Sharp'], ['♭', 'Flat'], ['♮', 'Natural'], ['>', 'Accent'],
    ['•', 'Staccato'], ['ƒ', 'Forte'], ['p', 'Piano'], ['mƒ', 'Mezzo Forte'], ['mp', 'Mezzo Piano'],
    ['ff', 'Fortissimo'], ['pp', 'Pianissimo'], ['⨅', 'Down Bow'], ['⋁', 'Up Bow'], ['𝄋', 'Segno'],
    ['𝄌', 'Coda'], [',', 'Breath'], ['1', 'Finger 1'], ['2', 'Finger 2'], ['3', 'Finger 3'],
    ['4', 'Finger 4'], ['5', 'Finger 5']
  ];

  onMount(async () => {
    isDualPage = window.innerWidth >= 1100;
    window.addEventListener('resize', handleResize);
    try {
      pdfUrl = URL.createObjectURL(score.pdfBlob);
      pdfDoc = await pdfjsLib.getDocument({ url: pdfUrl, disableAutoFetch: true, disableStream: true }).promise;
      totalPages = pdfDoc.numPages;
      const saved = await db.annotations.where('scoreId').equals(score.id).toArray();
      for (const record of saved) {
        annotations[record.pageNum] = record.strokes || [];
        stamps[record.pageNum] = record.stamps || [];
        notes[record.pageNum] = record.notes || [];
      }
      await renderPages();
    } catch (e) {
      console.error(e);
      error = 'This score could not be opened. The PDF may be damaged or unsupported.';
    } finally {
      loading = false;
    }
    return () => {
      window.removeEventListener('resize', handleResize);
      if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    };
  });

  function handleResize() {
    const nextDual = window.innerWidth >= 1100;
    if (nextDual !== isDualPage) {
      isDualPage = nextDual;
      renderPages();
    }
  }

  function snapshot(page: number) {
    return {
      strokes: structuredClone(annotations[page] || []),
      stamps: structuredClone(stamps[page] || []),
      notes: structuredClone(notes[page] || [])
    };
  }

  function saveHistory(page: number) {
    if (!historyStack[page]) historyStack[page] = [];
    historyStack[page].push(snapshot(page));
    redoStack[page] = [];
  }

  async function persist(page: number) {
    await db.annotations.put({
      id: `${score.id}_page_${page}`,
      scoreId: score.id,
      pageNum: page,
      strokes: annotations[page] || [],
      stamps: stamps[page] || [],
      notes: notes[page] || []
    });
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

  async function renderPages() {
    if (!pdfDoc || !mainContainerRef) return;
    const generation = ++renderGeneration;
    await renderSinglePage(currentPage, leftPdfCanvas, leftDrawCanvas, generation);
    if (generation !== renderGeneration) return;
    if (isDualPage && currentPage + 1 <= totalPages) {
      await renderSinglePage(currentPage + 1, rightPdfCanvas, rightDrawCanvas, generation);
    }
  }

  async function renderSinglePage(pageNum: number, pdfCanvas: HTMLCanvasElement | null, drawCanvas: HTMLCanvasElement | null, generation: number) {
    if (!pdfDoc || !pdfCanvas || !drawCanvas || !mainContainerRef) return;
    const page = await pdfDoc.getPage(pageNum);
    if (generation !== renderGeneration) return;
    const baseViewport = page.getViewport({ scale: 1 });
    const width = isDualPage ? Math.max(320, (mainContainerRef.clientWidth - 120) / 2) : Math.max(320, mainContainerRef.clientWidth - 72);
    const height = Math.max(320, mainContainerRef.clientHeight - 72);
    let scale = 1;
    if (fitMode === 'height') scale = height / baseViewport.height;
    if (fitMode === 'width') scale = width / baseViewport.width;
    if (fitMode === 'page') scale = Math.min(width / baseViewport.width, height / baseViewport.height);
    const viewport = page.getViewport({ scale: Math.max(0.1, scale * zoomLevel) });

    pdfCanvas.width = Math.ceil(viewport.width);
    pdfCanvas.height = Math.ceil(viewport.height);
    drawCanvas.width = pdfCanvas.width;
    drawCanvas.height = pdfCanvas.height;
    await page.render({ canvasContext: pdfCanvas.getContext('2d')!, viewport }).promise;
    if (generation === renderGeneration) redrawOverlay(pageNum, drawCanvas);
  }

  function redrawForPage(page: number) {
    if (page === currentPage) redrawOverlay(page, leftDrawCanvas);
    if (isDualPage && page === currentPage + 1) redrawOverlay(page, rightDrawCanvas);
  }

  function redrawOverlay(page: number, canvas: HTMLCanvasElement | null) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    for (const stroke of annotations[page] || []) {
      if (stroke.points.length === 1) {
        const p = stroke.points[0];
        ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.5, stroke.width / 2), 0, Math.PI * 2);
        ctx.fillStyle = stroke.tool === 'highlighter' ? 'rgba(250,204,21,.4)' : stroke.color; ctx.fill();
        continue;
      }
      ctx.save(); ctx.beginPath(); ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.strokeStyle = stroke.tool === 'highlighter' ? 'rgba(250,204,21,.4)' : stroke.color;
      ctx.lineWidth = stroke.tool === 'highlighter' ? Math.max(14, penWidth * 5) : stroke.width; ctx.stroke(); ctx.restore();
    }
    for (const s of stamps[page] || []) {
      ctx.save(); ctx.font = `${s.fontSize}px serif`; ctx.fillStyle = s.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s.symbol, s.x, s.y); ctx.restore();
    }
    for (const n of notes[page] || []) {
      ctx.save(); ctx.font = `600 ${n.fontSize}px sans-serif`; ctx.fillStyle = n.color; ctx.fillText(n.text, n.x, n.y); ctx.restore();
    }
    if (drawing?.page === page && drawing.canvas === canvas) {
      const stroke = drawing.stroke;
      ctx.save(); ctx.beginPath(); ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = stroke.tool === 'highlighter' ? 'rgba(250,204,21,.4)' : stroke.color; ctx.lineWidth = stroke.tool === 'highlighter' ? Math.max(14, penWidth * 5) : stroke.width; ctx.stroke(); ctx.restore();
    }
  }

  function pointFor(e: PointerEvent, canvas: HTMLCanvasElement) {
    const rect = canvas.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * canvas.width / rect.width, y: (e.clientY - rect.top) * canvas.height / rect.height };
  }

  function pointerDown(e: PointerEvent, page: number, canvas: HTMLCanvasElement) {
    if (!isAnnotationToolOpen || e.button !== 0) return;
    e.preventDefault();
    const p = pointFor(e, canvas);
    if (e.pointerType === 'pen') activeTool = 'pen';

    if (activeTool === 'stamp') {
      saveHistory(page); if (!stamps[page]) stamps[page] = [];
      stamps[page].push({ id: crypto.randomUUID(), symbol: selectedSymbol, label: 'stamp', x: p.x, y: p.y, fontSize: 32, color: penColor });
      redrawOverlay(page, canvas); persist(page); return;
    }
    if (activeTool === 'text') {
      const text = prompt('Enter rehearsal note / instruction:');
      if (text?.trim()) { saveHistory(page); if (!notes[page]) notes[page] = []; notes[page].push({ id: crypto.randomUUID(), text: text.trim(), x: p.x, y: p.y, fontSize: 16, color: penColor }); redrawOverlay(page, canvas); persist(page); }
      return;
    }
    if (activeTool === 'eraser') { saveHistory(page); eraseAt(p.x, p.y, page, canvas); return; }

    saveHistory(page);
    const stroke: Stroke = { tool: activeTool === 'highlighter' ? 'highlighter' : 'pen', color: penColor, width: penWidth, points: [p] };
    drawing = { page, pointerId: e.pointerId, canvas, stroke };
    canvas.setPointerCapture(e.pointerId);
    redrawOverlay(page, canvas);
  }

  function pointerMove(e: PointerEvent, page: number, canvas: HTMLCanvasElement) {
    if (drawing?.page !== page || drawing.canvas !== canvas || drawing.pointerId !== e.pointerId) return;
    const p = pointFor(e, canvas);
    drawing.stroke.points.push(p);
    redrawOverlay(page, canvas);
  }

  async function finishDrawing(e: PointerEvent, page: number, canvas: HTMLCanvasElement) {
    if (drawing?.page !== page || drawing.canvas !== canvas || drawing.pointerId !== e.pointerId) return;
    const active = drawing;
    drawing = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    if (!annotations[page]) annotations[page] = [];
    annotations[page].push(active.stroke);
    await persist(page);
    redrawOverlay(page, canvas);
  }

  function cancelDrawing(e: PointerEvent, page: number, canvas: HTMLCanvasElement) {
    if (drawing?.page !== page || drawing.canvas !== canvas || drawing.pointerId !== e.pointerId) return;
    drawing = null;
    if (canvas.hasPointerCapture(e.pointerId)) canvas.releasePointerCapture(e.pointerId);
    historyStack[page]?.pop();
    redrawOverlay(page, canvas);
  }

  function eraseAt(x: number, y: number, page: number, canvas: HTMLCanvasElement) {
    const radius = Math.max(18, penWidth * 4);
    annotations[page] = (annotations[page] || []).filter(s => !s.points.some(p => Math.hypot(p.x - x, p.y - y) <= radius));
    stamps[page] = (stamps[page] || []).filter(s => Math.hypot(s.x - x, s.y - y) > radius + 12);
    notes[page] = (notes[page] || []).filter(n => Math.hypot(n.x - x, n.y - y) > radius + 12);
    redrawOverlay(page, canvas); persist(page);
  }

  function goToPage(page: number) {
    const step = isDualPage ? 2 : 1;
    const target = Math.max(1, Math.min(totalPages, page));
    if (target !== currentPage) { currentPage = target; renderPages(); }
  }

  function nextPage() { goToPage(currentPage + (isDualPage ? 2 : 1)); }
  function previousPage() { goToPage(currentPage - (isDualPage ? 2 : 1)); }

  function handleKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    if (e.key === 'ArrowRight' || e.key === 'PageDown') { e.preventDefault(); nextPage(); }
    if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); previousPage(); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(currentPage); }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(currentPage); }
    if (e.key.toLowerCase() === 'p') activeTool = 'pen';
    if (e.key.toLowerCase() === 'h') activeTool = 'highlighter';
    if (e.key.toLowerCase() === 'e') activeTool = 'eraser';
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

<div class="flex-1 flex flex-col relative bg-neutral-950 overflow-hidden select-none">
  <header class="h-14 shrink-0 flex items-center justify-between gap-3 px-3 sm:px-5 bg-neutral-900/95 backdrop-blur-xl border-b border-neutral-800 z-20">
    <div class="flex items-center gap-2 min-w-0">
      <button onclick={onBack} class="p-2 rounded-xl text-neutral-400 hover:text-white hover:bg-neutral-800" title="Back to library"><ArrowLeft size={18}/></button>
      <div class="min-w-0 hidden sm:block"><div class="text-sm font-semibold truncate max-w-64">{score.title}</div><div class="text-[11px] text-neutral-500 truncate">{score.composer}</div></div>
    </div>

    <div class="flex items-center gap-1.5">
      <button onclick={previousPage} disabled={currentPage <= 1} class="p-2 rounded-xl hover:bg-neutral-800 text-neutral-400 hover:text-white disabled:opacity-30"><ChevronLeft size={18}/></button>
      <div class="flex items-center gap-1 text-xs text-neutral-400 min-w-20 justify-center"><input aria-label="Page" type="number" min="1" max={totalPages} bind:value={currentPage} onchange={() => goToPage(currentPage)} class="w-10 bg-neutral-950 border border-neutral-800 rounded-lg px-1.5 py-1 text-center text-neutral-200"/><span>/ {totalPages}</span></div>
      <button onclick={nextPage} disabled={currentPage >= totalPages} class="p-2 rounded-xl hover:bg-neutral-800 text-neutral-400 hover:text-white disabled:opacity-30"><ChevronRight size={18}/></button>
    </div>

    <div class="flex items-center gap-1.5">
      <div class="hidden md:flex items-center bg-neutral-950 border border-neutral-800 rounded-xl p-0.5">
        <button onclick={() => { zoomLevel = Math.max(.5, zoomLevel - .1); renderPages(); }} class="p-1.5 text-neutral-400 hover:text-white"><ZoomOut size={15}/></button>
        <span class="text-[11px] font-mono w-10 text-center text-neutral-300">{Math.round(zoomLevel * 100)}%</span>
        <button onclick={() => { zoomLevel = Math.min(3, zoomLevel + .1); renderPages(); }} class="p-1.5 text-neutral-400 hover:text-white"><ZoomIn size={15}/></button>
        <button onclick={() => { zoomLevel = 1; fitMode = 'height'; renderPages(); }} class="p-1.5 text-neutral-500 hover:text-white border-l border-neutral-800 ml-1"><RotateCcw size={14}/></button>
      </div>
      <button onclick={() => isAnnotationToolOpen = !isAnnotationToolOpen} class="p-2 rounded-xl border {isAnnotationToolOpen ? 'bg-blue-600/20 border-blue-500/50 text-blue-300' : 'bg-neutral-950 border-neutral-800 text-neutral-400 hover:text-white'}" title="Annotations"><Pencil size={17}/></button>
      <button onclick={() => isDualPage = !isDualPage; renderPages()} class="p-2 rounded-xl border border-neutral-800 bg-neutral-950 text-neutral-400 hover:text-white" title="Toggle facing pages">{#if isDualPage}<Columns size={17}/>{:else}<Square size={17}/>{/if}</button>
    </div>
  </header>

  {#if isAnnotationToolOpen}
    <div class="absolute top-16 left-1/2 -translate-x-1/2 z-30 max-w-[calc(100%-1rem)] bg-neutral-900/95 backdrop-blur-xl border border-neutral-700 rounded-2xl shadow-2xl p-2 flex flex-wrap items-center justify-center gap-1.5">
      <button onclick={() => activeTool='pen'} class="tool {activeTool==='pen' ? 'active':''}" title="Pen (P)"><Pencil size={16}/></button>
      <button onclick={() => activeTool='highlighter'} class="tool {activeTool==='highlighter' ? 'active':''}" title="Highlighter (H)"><Highlighter size={16}/></button>
      <button onclick={() => activeTool='eraser'} class="tool {activeTool==='eraser' ? 'active':''}" title="Eraser (E)"><Eraser size={16}/></button>
      <button onclick={() => activeTool='stamp'} class="tool {activeTool==='stamp' ? 'active':''}" title="Musical symbol"><Music2 size={16}/></button>
      <button onclick={() => activeTool='text'} class="tool {activeTool==='text' ? 'active':''}" title="Text note"><Type size={16}/></button>
      <span class="w-px h-6 bg-neutral-700 mx-1"></span>
      {#each QUICK_COLORS as color}<button onclick={() => penColor=color} class="w-5 h-5 rounded-full border-2 {penColor===color ? 'border-white scale-110':'border-neutral-600'}" style={`background:${color}`}></button>{/each}
      <label class="flex items-center gap-1.5 text-xs text-neutral-400 px-1"><span>Size</span><input type="range" min="1" max="12" bind:value={penWidth}/></label>
      <button onclick={() => undo(currentPage)} disabled={!historyStack[currentPage]?.length} class="tool" title="Undo"><Undo size={16}/></button>
      <button onclick={() => redo(currentPage)} disabled={!redoStack[currentPage]?.length} class="tool" title="Redo"><Redo size={16}/></button>
      {#if activeTool === 'stamp'}
        <select bind:value={selectedSymbol} class="bg-neutral-950 border border-neutral-700 rounded-lg text-sm px-2 py-1.5"><option value="𝄐">𝄐 Fermata</option>{#each MUSICAL_SYMBOLS as item}<option value={item[0]}>{item[0]} {item[1]}</option>{/each}</select>
      {/if}
    </div>
  {/if}

  <main bind:this={mainContainerRef} class="relative flex-1 overflow-auto flex items-center justify-center p-3 sm:p-5 bg-neutral-950">
    {#if loading}
      <div class="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">Opening score…</div>
    {:else if error}
      <div class="max-w-md text-center"><div class="text-red-400 mb-2">Unable to open score</div><p class="text-sm text-neutral-500 mb-4">{error}</p><button onclick={onBack} class="px-4 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm">Return to library</button></div>
    {:else}
      <button onclick={previousPage} disabled={currentPage <= 1 || isAnnotationToolOpen} class="page-zone left-0"><ChevronLeft size={32}/></button>
      <button onclick={nextPage} disabled={currentPage >= totalPages || isAnnotationToolOpen} class="page-zone right-0"><ChevronRight size={32}/></button>
      <div class="flex gap-4 items-center justify-center max-w-full">
        <div class="relative shadow-2xl bg-white {filterMode==='sepia'?'sepia contrast-105 brightness-95':''} {filterMode==='dark'?'invert hue-rotate-180 contrast-125':''}">
          <canvas bind:this={leftPdfCanvas} class="block"></canvas>
          <canvas bind:this={leftDrawCanvas} onpointerdown={(e)=>leftDrawCanvas&&pointerDown(e,currentPage,leftDrawCanvas)} onpointermove={(e)=>leftDrawCanvas&&pointerMove(e,currentPage,leftDrawCanvas)} onpointerup={(e)=>leftDrawCanvas&&finishDrawing(e,currentPage,leftDrawCanvas)} onpointercancel={(e)=>leftDrawCanvas&&cancelDrawing(e,currentPage,leftDrawCanvas)} class="absolute inset-0 touch-none {isAnnotationToolOpen?'cursor-crosshair':'pointer-events-none'}"></canvas>
        </div>
        {#if isDualPage && currentPage + 1 <= totalPages}
          <div class="relative shadow-2xl bg-white {filterMode==='sepia'?'sepia contrast-105 brightness-95':''} {filterMode==='dark'?'invert hue-rotate-180 contrast-125':''}">
            <canvas bind:this={rightPdfCanvas} class="block"></canvas>
            <canvas bind:this={rightDrawCanvas} onpointerdown={(e)=>rightDrawCanvas&&pointerDown(e,currentPage+1,rightDrawCanvas)} onpointermove={(e)=>rightDrawCanvas&&pointerMove(e,currentPage+1,rightDrawCanvas)} onpointerup={(e)=>rightDrawCanvas&&finishDrawing(e,currentPage+1,rightDrawCanvas)} onpointercancel={(e)=>rightDrawCanvas&&cancelDrawing(e,currentPage+1,rightDrawCanvas)} class="absolute inset-0 touch-none {isAnnotationToolOpen?'cursor-crosshair':'pointer-events-none'}"></canvas>
          </div>
        {/if}
      </div>
    {/if}
  </main>

  <footer class="h-11 shrink-0 flex items-center justify-between px-4 bg-neutral-900/90 border-t border-neutral-800 text-[11px] text-neutral-500">
    <div class="hidden sm:block">{score.composer} · {score.title}</div>
    <div class="flex items-center gap-1">
      <button onclick={() => fitMode='height'; renderPages()} class="px-2 py-1 rounded-lg {fitMode==='height'?'bg-neutral-800 text-neutral-200':''}">Fit height</button>
      <button onclick={() => fitMode='width'; renderPages()} class="px-2 py-1 rounded-lg {fitMode==='width'?'bg-neutral-800 text-neutral-200':''}">Fit width</button>
      <button onclick={() => fitMode='page'; renderPages()} class="px-2 py-1 rounded-lg {fitMode==='page'?'bg-neutral-800 text-neutral-200':''}">Fit page</button>
    </div>
    <div class="flex items-center gap-1">
      <button onclick={() => filterMode='normal'} class="p-1.5 rounded-lg {filterMode==='normal'?'bg-neutral-800 text-neutral-200':''}"><Sun size={14}/></button>
      <button onclick={() => filterMode='sepia'} class="p-1.5 rounded-lg {filterMode==='sepia'?'bg-amber-900/50 text-amber-200':''}"><BookOpen size={14}/></button>
      <button onclick={() => filterMode='dark'} class="p-1.5 rounded-lg {filterMode==='dark'?'bg-neutral-800 text-neutral-200':''}"><Moon size={14}/></button>
    </div>
  </footer>
</div>

<style>
  .tool { width: 34px; height: 34px; display:flex; align-items:center; justify-content:center; border-radius:10px; color:#a3a3a3; background:#171717; border:1px solid #262626; }
  .tool:hover { color:white; background:#262626; }
  .tool.active { color:#93c5fd; background:#1e3a5f; border-color:#3b82f6; }
  .tool:disabled { opacity:.35; }
  .page-zone { position:absolute; top:0; bottom:0; width:12%; z-index:10; display:flex; align-items:center; padding:0 1rem; color:rgba(255,255,255,.5); opacity:0; transition:.15s; background:transparent; }
  .page-zone:hover:not(:disabled) { opacity:1; background:linear-gradient(90deg,rgba(23,23,23,.5),transparent); }
  .page-zone.right { right:0; justify-content:flex-end; }
  .page-zone.right:hover:not(:disabled) { background:linear-gradient(270deg,rgba(23,23,23,.5),transparent); }
  .page-zone:disabled { pointer-events:none; }
</style>