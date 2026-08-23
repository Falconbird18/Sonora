<script lang="ts">
  import { onMount, tick } from 'svelte';
  import * as pdfjsLib from 'pdfjs-dist';
  import {
    ArrowLeft, ChevronLeft, ChevronRight, Pencil, Highlighter,
    Eraser, Trash2, Sun, Moon, BookOpen, Columns, Square,
    ZoomIn, ZoomOut, Maximize2, RotateCcw, Undo, Redo,
    Music2, Type, Palette
  } from 'lucide-svelte';
  import { db } from './db';
  import type { ScoreItem, Stroke, SymbolStamp, TextNote } from './types';

  let { score, onBack }: { score: ScoreItem; onBack: () => void } = $props();

  // Score & Layout State
  let pdfDoc = $state<pdfjsLib.PDFDocumentProxy | null>(null);
  let currentPage = $state(1);
  let totalPages = $state(0);
  let filterMode = $state<'normal' | 'sepia' | 'dark'>('normal');
  let isDualPage = $state(false);

  // Zoom & View Fit Modes
  let fitMode = $state<'height' | 'width' | 'page'>('height'); // DEFAULT VERTICAL FIT
  let zoomLevel = $state(1.0);

  // Annotation Tool State
  let isAnnotationToolOpen = $state(false);
  let activeTool = $state<'pen' | 'highlighter' | 'stamp' | 'text' | 'eraser'>('pen');
  let penColor = $state('#ef4444');
  let penWidth = $state(3);
  let selectedSymbol = $state('𝄐'); // Default Fermata

  // Page Annotations Data
  let annotations = $state<Record<number, Stroke[]>>({});
  let stamps = $state<Record<number, SymbolStamp[]>>({});
  let notes = $state<Record<number, TextNote[]>>({});

  // Undo / Redo History
  let historyStack = $state<Record<number, { strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[] }[]>>({});
  let redoStack = $state<Record<number, { strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[] }[]>>({});

  // Drawing State
  let currentStroke = $state<Stroke | null>(null);
  let isDrawing = false;

  // DOM Refs
  let leftPdfCanvas = $state<HTMLCanvasElement | null>(null);
  let leftDrawCanvas = $state<HTMLCanvasElement | null>(null);
  let rightPdfCanvas = $state<HTMLCanvasElement | null>(null);
  let rightDrawCanvas = $state<HTMLCanvasElement | null>(null);
  let mainContainerRef = $state<HTMLDivElement | null>(null);

  // Musical Symbols Palette
  const MUSICAL_SYMBOLS = [
    { symbol: '𝄐', label: 'Fermata' },
    { symbol: '♯', label: 'Sharp' },
    { symbol: '♭', label: 'Flat' },
    { symbol: '♮', label: 'Natural' },
    { symbol: '>', label: 'Accent' },
    { symbol: '•', label: 'Staccato' },
    { symbol: 'ƒ', label: 'Forte' },
    { symbol: ' shade p', label: 'Piano' },
    { symbol: 'mƒ', label: 'Mezzo Forte' },
    { symbol: 'mp', label: 'Mezzo Piano' },
    { symbol: 'ff', label: 'Fortissimo' },
    { symbol: 'pp', label: 'Pianissimo' },
    { symbol: '⨅', label: 'Down Bow' },
    { symbol: '⋁', label: 'Up Bow' },
    { symbol: '𝄋', label: 'Segno' },
    { symbol: '𝄌', label: 'Coda' },
    { symbol: ',', label: 'Breath Mark' },
    { symbol: '1', label: 'Finger 1' },
    { symbol: '2', label: 'Finger 2' },
    { symbol: '3', label: 'Finger 3' },
    { symbol: '4', label: 'Finger 4' },
    { symbol: '5', label: 'Finger 5' }
  ];

  const QUICK_COLORS = ['#ef4444', '#3b82f6', '#10b981', '#eab308', '#a855f7', '#ffffff', '#000000'];

  onMount(async () => {
    isDualPage = window.innerWidth >= 1024;

    try {
      const buffer = await score.pdfBlob.arrayBuffer();
      pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
      totalPages = pdfDoc.numPages;

      const savedAnns = await db.annotations.where('scoreId').equals(score.id).toArray();
      for (const record of savedAnns) {
        annotations[record.pageNum] = record.strokes || [];
        stamps[record.pageNum] = record.stamps || [];
        notes[record.pageNum] = record.notes || [];
      }

      await renderPages();
    } catch (err) {
      console.error('PDF error:', err);
    }
  });

  function saveCurrentStateToHistory(pageNum: number) {
    if (!historyStack[pageNum]) historyStack[pageNum] = [];
    historyStack[pageNum].push({
      strokes: JSON.parse(JSON.stringify(annotations[pageNum] || [])),
      stamps: JSON.parse(JSON.stringify(stamps[pageNum] || [])),
      notes: JSON.parse(JSON.stringify(notes[pageNum] || []))
    });
    redoStack[pageNum] = []; // Clear redo stack on new action
  }

  function undo(pageNum: number) {
    if (!historyStack[pageNum] || historyStack[pageNum].length === 0) return;

    // Save current state to redo
    if (!redoStack[pageNum]) redoStack[pageNum] = [];
    redoStack[pageNum].push({
      strokes: JSON.parse(JSON.stringify(annotations[pageNum] || [])),
      stamps: JSON.parse(JSON.stringify(stamps[pageNum] || [])),
      notes: JSON.parse(JSON.stringify(notes[pageNum] || []))
    });

    const previous = historyStack[pageNum].pop()!;
    annotations[pageNum] = previous.strokes;
    stamps[pageNum] = previous.stamps;
    notes[pageNum] = previous.notes;

    saveToDb(pageNum);
    renderPages();
  }

  function redo(pageNum: number) {
    if (!redoStack[pageNum] || redoStack[pageNum].length === 0) return;

    saveCurrentStateToHistory(pageNum);
    const next = redoStack[pageNum].pop()!;
    annotations[pageNum] = next.strokes;
    stamps[pageNum] = next.stamps;
    notes[pageNum] = next.notes;

    saveToDb(pageNum);
    renderPages();
  }

  async function renderPages() {
    if (!pdfDoc || !mainContainerRef) return;
    await renderSinglePage(currentPage, leftPdfCanvas, leftDrawCanvas);

    if (isDualPage && currentPage + 1 <= totalPages) {
      await renderSinglePage(currentPage + 1, rightPdfCanvas, rightDrawCanvas);
    }
  }

  async function renderSinglePage(
    pageNum: number,
    pdfCanvas: HTMLCanvasElement | null,
    drawCanvas: HTMLCanvasElement | null
  ) {
    if (!pdfDoc || !pdfCanvas || !drawCanvas || !mainContainerRef) return;

    const page = await pdfDoc.getPage(pageNum);
    const unscaledViewport = page.getViewport({ scale: 1.0 });

    const availableWidth = isDualPage ? (mainContainerRef.clientWidth - 96) / 2 : mainContainerRef.clientWidth - 64;
    const availableHeight = mainContainerRef.clientHeight - 48; // Leave margin for controls

    let baseScale = 1.0;
    if (fitMode === 'height') {
      baseScale = availableHeight / unscaledViewport.height; // VERTICAL FIT DEFAULT
    } else if (fitMode === 'width') {
      baseScale = availableWidth / unscaledViewport.width;
    } else if (fitMode === 'page') {
      baseScale = Math.min(availableWidth / unscaledViewport.width, availableHeight / unscaledViewport.height);
    }

    const finalScale = baseScale * zoomLevel;
    const viewport = page.getViewport({ scale: finalScale });

    pdfCanvas.width = viewport.width;
    pdfCanvas.height = viewport.height;
    drawCanvas.width = viewport.width;
    drawCanvas.height = viewport.height;

    const ctx = pdfCanvas.getContext('2d')!;
    await page.render({ canvasContext: ctx, viewport }).promise;

    redrawOverlay(pageNum, drawCanvas);
  }

  function redrawOverlay(pageNum: number, canvas: HTMLCanvasElement | null) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d')!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // Render Strokes
    const pageStrokes = annotations[pageNum] || [];
    pageStrokes.forEach(stroke => {
      if (stroke.points.length < 2) return;
      ctx.save();
      ctx.beginPath();
      ctx.moveTo(stroke.points[0].x, stroke.points[0].y);
      for (let i = 1; i < stroke.points.length; i++) {
        ctx.lineTo(stroke.points[i].x, stroke.points[i].y);
      }
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';

      if (stroke.tool === 'highlighter') {
        ctx.strokeStyle = 'rgba(250, 204, 21, 0.4)';
        ctx.lineWidth = 20;
      } else {
        ctx.strokeStyle = stroke.color;
        ctx.lineWidth = stroke.width;
      }
      ctx.stroke();
      ctx.restore();
    });

    // Render Musical Symbol Stamps
    const pageStamps = stamps[pageNum] || [];
    pageStamps.forEach(s => {
      ctx.save();
      ctx.font = `${s.fontSize}px serif`;
      ctx.fillStyle = s.color;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(s.symbol, s.x, s.y);
      ctx.restore();
    });

    // Render Text Notes
    const pageNotes = notes[pageNum] || [];
    pageNotes.forEach(n => {
      ctx.save();
      ctx.font = `600 ${n.fontSize}px sans-serif`;
      ctx.fillStyle = n.color;
      ctx.fillText(n.text, n.x, n.y);
      ctx.restore();
    });
  }

  async function saveToDb(pageNum: number) {
    await db.annotations.put({
      id: `${score.id}_page_${pageNum}`,
      scoreId: score.id,
      pageNum,
      strokes: annotations[pageNum] || [],
      stamps: stamps[pageNum] || [],
      notes: notes[pageNum] || []
    });
  }

  // Pointer Event Handling (Pen / Stylus Auto-Detection & Stamps)
  function handlePointerDown(e: PointerEvent, pageNum: number, canvas: HTMLCanvasElement) {
    if (!isAnnotationToolOpen) return;

    // Stylus / Apple Pencil Auto Enable
    if (e.pointerType === 'pen') {
      activeTool = 'pen';
    }

    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (activeTool === 'stamp') {
      saveCurrentStateToHistory(pageNum);
      if (!stamps[pageNum]) stamps[pageNum] = [];
      stamps[pageNum].push({
        id: Math.random().toString(),
        symbol: selectedSymbol,
        label: 'stamp',
        x, y,
        fontSize: 32,
        color: penColor
      });
      redrawOverlay(pageNum, canvas);
      saveToDb(pageNum);
      return;
    }

    if (activeTool === 'text') {
      const textPrompt = prompt('Enter rehearsal note / instruction:');
      if (textPrompt) {
        saveCurrentStateToHistory(pageNum);
        if (!notes[pageNum]) notes[pageNum] = [];
        notes[pageNum].push({
          id: Math.random().toString(),
          text: textPrompt,
          x, y,
          fontSize: 16,
          color: penColor
        });
        redrawOverlay(pageNum, canvas);
        saveToDb(pageNum);
      }
      return;
    }

    if (activeTool === 'eraser') {
      saveCurrentStateToHistory(pageNum);
      eraseAtPoint(x, y, pageNum, canvas);
      return;
    }

    // Pen & Highlighter Drawing
    isDrawing = true;
    canvas.setPointerCapture(e.pointerId);
    saveCurrentStateToHistory(pageNum);

    currentStroke = {
      tool: activeTool === 'highlighter' ? 'highlighter' : 'pen',
      color: penColor,
      width: penWidth,
      points: [{ x, y }]
    };
  }

  function handlePointerMove(e: PointerEvent, pageNum: number, canvas: HTMLCanvasElement) {
    if (!isDrawing) return;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;

    if (activeTool === 'eraser') {
      eraseAtPoint(x, y, pageNum, canvas);
      return;
    }

    if (currentStroke) {
      currentStroke.points.push({ x, y });
      redrawOverlay(pageNum, canvas);
    }
  }

  async function handlePointerUp(e: PointerEvent, pageNum: number, canvas: HTMLCanvasElement) {
    if (!isDrawing) return;
    isDrawing = false;
    canvas.releasePointerCapture(e.pointerId);

    if (currentStroke && currentStroke.points.length > 1) {
      if (!annotations[pageNum]) annotations[pageNum] = [];
      annotations[pageNum].push(currentStroke);
      await saveToDb(pageNum);
    }
    currentStroke = null;
  }

  function eraseAtPoint(x: number, y: number, pageNum: number, canvas: HTMLCanvasElement) {
    annotations[pageNum] = (annotations[pageNum] || []).filter(stroke => {
      return !stroke.points.some(p => Math.hypot(p.x - x, p.y - y) < 20);
    });
    stamps[pageNum] = (stamps[pageNum] || []).filter(s => Math.hypot(s.x - x, s.y - y) > 25);
    notes[pageNum] = (notes[pageNum] || []).filter(n => Math.hypot(n.x - x, n.y - y) > 30);

    redrawOverlay(pageNum, canvas);
    saveToDb(pageNum);
  }

  function goToPage(num: number) {
    if (num >= 1 && num <= totalPages) {
      currentPage = num;
      renderPages();
    }
  }

  function handleKeyDown(e: KeyboardEvent) {
    const step = isDualPage ? 2 : 1;
    if (['ArrowRight', 'PageDown'].includes(e.key)) goToPage(currentPage + step);
    if (['ArrowLeft', 'PageUp'].includes(e.key)) goToPage(currentPage - step);
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') undo(currentPage);
    if (e.key === 'p') activeTool = 'pen';
    if (e.key === 'h') activeTool = 'highlighter';
    if (e.key === 's') activeTool = 'stamp';
    if (e.key === 'e') activeTool = 'eraser';
  }
</script>

<svelte:window onkeydown={handleKeyDown} />

<div class="flex-1 flex flex-col relative bg-neutral-950 overflow-hidden select-none">

  <!-- Header Controls -->
  <header class="flex items-center justify-between px-4 py-2.5 bg-neutral-900/90 backdrop-blur-md border-b border-neutral-800 z-20">
    <button onclick={onBack} class="flex items-center gap-2 text-neutral-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-neutral-800 transition">
      <ArrowLeft size={18} />
      <span class="text-sm font-medium">Library</span>
    </button>

    <div class="text-center truncate px-2">
      <h2 class="text-sm font-semibold text-neutral-200 truncate">{score.title}</h2>
      <p class="text-xs text-neutral-500">{score.composer}</p>
    </div>

    <!-- Zoom & Fit Controls -->
    <div class="flex items-center gap-2">
      <div class="flex items-center bg-neutral-950 rounded-xl border border-neutral-800 p-1">
        <button onclick={() => { zoomLevel = Math.max(0.5, zoomLevel - 0.15); renderPages(); }} class="p-1.5 text-neutral-400 hover:text-white"><ZoomOut size={16} /></button>
        <span class="text-xs font-mono px-2 text-neutral-300">{Math.round(zoomLevel * 100)}%</span>
        <button onclick={() => { zoomLevel = Math.min(3.0, zoomLevel + 0.15); renderPages(); }} class="p-1.5 text-neutral-400 hover:text-white"><ZoomIn size={16} /></button>
        <button onclick={() => { zoomLevel = 1.0; fitMode = 'height'; renderPages(); }} class="p-1.5 text-neutral-400 hover:text-white border-l border-neutral-800 pl-2" title="Reset Vertical Fit">
          <RotateCcw size={14} />
        </button>
      </div>

      <!-- Fit Mode Selector -->
      <div class="flex bg-neutral-950 rounded-xl border border-neutral-800 p-1 text-xs">
        <button onclick={() => { fitMode = 'height'; renderPages(); }} class="px-2 py-1 rounded-lg {fitMode === 'height' ? 'bg-neutral-800 text-blue-400 font-semibold' : 'text-neutral-400'}">Fit Height</button>
        <button onclick={() => { fitMode = 'width'; renderPages(); }} class="px-2 py-1 rounded-lg {fitMode === 'width' ? 'bg-neutral-800 text-blue-400 font-semibold' : 'text-neutral-400'}">Fit Width</button>
      </div>

      <button onclick={() => { isDualPage = !isDualPage; renderPages(); }} class="p-2 rounded-xl border border-neutral-800 bg-neutral-950 text-neutral-400 hover:text-white">
        {#if isDualPage}<Columns size={16} class="text-blue-400" />{:else}<Square size={16} />{/if}
      </button>

      <div class="flex items-center gap-1 bg-neutral-950 p-1 rounded-xl border border-neutral-800">
        <button class="p-1.5 rounded-lg {filterMode === 'normal' ? 'bg-neutral-800 text-white' : 'text-neutral-500'}" onclick={() => filterMode = 'normal'}><Sun size={16} /></button>
        <button class="p-1.5 rounded-lg {filterMode === 'sepia' ? 'bg-amber-900/60 text-amber-200' : 'text-neutral-500'}" onclick={() => filterMode = 'sepia'}><BookOpen size={16} /></button>
        <button class="p-1.5 rounded-lg {filterMode === 'dark' ? 'bg-neutral-800 text-white' : 'text-neutral-500'}" onclick={() => filterMode = 'dark'}><Moon size={16} /></button>
      </div>
    </div>
  </header>

  <!-- Main View Area with Large Touch Page Turn Zones -->
  <div bind:this={mainContainerRef} class="flex-1 overflow-auto flex justify-center items-center p-2 relative">

    <!-- LEFT PAGE TURN ZONE -->
    <button
      disabled={currentPage <= 1}
      onclick={() => goToPage(currentPage - (isDualPage ? 2 : 1))}
      class="absolute left-0 top-0 bottom-0 w-1/6 z-10 flex items-center justify-start pl-4 opacity-0 hover:opacity-100 hover:bg-gradient-to-r hover:from-neutral-900/40 hover:to-transparent transition cursor-pointer disabled:pointer-events-none {isAnnotationToolOpen ? 'pointer-events-none' : ''}">
      <ChevronLeft size={36} class="text-white/70" />
    </button>

    <!-- RIGHT PAGE TURN ZONE -->
    <button
      disabled={currentPage >= totalPages}
      onclick={() => goToPage(currentPage + (isDualPage ? 2 : 1))}
      class="absolute right-0 top-0 bottom-0 w-1/6 z-10 flex items-center justify-end pr-4 opacity-0 hover:opacity-100 hover:bg-gradient-to-l hover:from-neutral-900/40 hover:to-transparent transition cursor-pointer disabled:pointer-events-none {isAnnotationToolOpen ? 'pointer-events-none' : ''}">
      <ChevronRight size={36} class="text-white/70" />
    </button>

    <!-- SCORE CANVASES -->
    <div class="flex gap-4 max-w-full max-h-full justify-center items-center z-0">

      <!-- LEFT PAGE -->
      <div class="relative shadow-2xl rounded overflow-hidden bg-white
        {filterMode === 'sepia' ? 'sepia contrast-105 brightness-95' : ''}
        {filterMode === 'dark' ? 'invert hue-rotate-180 contrast-125' : ''}">
        <canvas bind:this={leftPdfCanvas} class="block"></canvas>
        <canvas
          bind:this={leftDrawCanvas}
          onpointerdown={(e) => leftDrawCanvas && handlePointerDown(e, currentPage, leftDrawCanvas)}
          onpointermove={(e) => leftDrawCanvas && handlePointerMove(e, currentPage, leftDrawCanvas)}
          onpointerup={(e) => leftDrawCanvas && handlePointerUp(e, currentPage, leftDrawCanvas)}
          class="absolute top-0 left-0 touch-none {isAnnotationToolOpen ? 'cursor-crosshair' : 'pointer-events-none'}">
        </canvas>
      </div>

      <!-- RIGHT PAGE (DUAL MODE) -->
      {#if isDualPage && currentPage + 1 <= totalPages}
        <div class="relative shadow-2xl rounded overflow-hidden bg-white
          {filterMode === 'sepia' ? 'sepia contrast-105 brightness-95' : ''}
          {filterMode === 'dark' ? 'invert hue-rotate-180 contrast-125' : ''}">
          <canvas bind:this={rightPdfCanvas} class="block"></canvas>
          <canvas
            bind:this={rightDrawCanvas}
            onpointerdown={(e) => rightDrawCanvas && handlePointerDown(e, currentPage + 1, rightDrawCanvas)}
            onpointermove={(e) => rightDrawCanvas && handlePointerMove(e, currentPage + 1, rightDrawCanvas)}
            onpointerup={(e) => rightDrawCanvas && handlePointerUp(e, currentPage + 1, rightDrawCanvas)}
            class="absolute top-0 left-0 touch-none {isAnnotationToolOpen ? 'cursor-crosshair' : 'pointer-events-none'}">
          </canvas>
        </div>
      {/if}

    </div>
  </div>

  <!-- FLOATING PRO MUSICIAN ANNOTATION TOOLBAR -->
  {#if isAnnotationToolOpen}
    <div class="absolute top-14 left-1/2 -translate-x-1/2 z-30 bg-neutral-900/95 backdrop-blur-xl border border-neutral-700/80 p-2.5 rounded-2xl shadow-2xl flex flex-col gap-2 max-w-xl">

      <!-- Main Tools & Actions -->
      <div class="flex items-center gap-2 overflow-x-auto">
        <button class="p-2 rounded-xl transition {activeTool === 'pen' ? 'bg-blue-600 text-white' : 'text-neutral-400'}" onclick={() => activeTool = 'pen'} title="Pen (P)"><Pencil size={18} /></button>
        <button class="p-2 rounded-xl transition {activeTool === 'highlighter' ? 'bg-yellow-500/20 text-yellow-400' : 'text-neutral-400'}" onclick={() => activeTool = 'highlighter'} title="Highlighter (H)"><Highlighter size={18} /></button>
        <button class="p-2 rounded-xl transition {activeTool === 'stamp' ? 'bg-purple-600 text-white' : 'text-neutral-400'}" onclick={() => activeTool = 'stamp'} title="Musical Symbols (S)"><Music2 size={18} /></button>
        <button class="p-2 rounded-xl transition {activeTool === 'text' ? 'bg-emerald-600 text-white' : 'text-neutral-400'}" onclick={() => activeTool = 'text'} title="Text Note (T)"><Type size={18} /></button>
        <button class="p-2 rounded-xl transition {activeTool === 'eraser' ? 'bg-neutral-800 text-white' : 'text-neutral-400'}" onclick={() => activeTool = 'eraser'} title="Eraser (E)"><Eraser size={18} /></button>

        <div class="h-5 w-px bg-neutral-800 mx-1"></div>

        <!-- Color Palette -->
        <div class="flex items-center gap-1">
          {#each QUICK_COLORS as color}
            <button
              onclick={() => penColor = color}
              style="background-color: {color}"
              class="w-5 h-5 rounded-full border border-neutral-700 transition hover:scale-110 {penColor === color ? 'ring-2 ring-blue-500 scale-110' : ''}">
            </button>
          {/each}
        </div>

        <div class="h-5 w-px bg-neutral-800 mx-1"></div>

        <!-- Undo / Redo / Clear -->
        <button onclick={() => undo(currentPage)} class="p-2 text-neutral-400 hover:text-white rounded-xl" title="Undo"><Undo size={16} /></button>
        <button onclick={() => redo(currentPage)} class="p-2 text-neutral-400 hover:text-white rounded-xl" title="Redo"><Redo size={16} /></button>
        <button onclick={() => { saveCurrentStateToHistory(currentPage); annotations[currentPage] = []; stamps[currentPage] = []; notes[currentPage] = []; renderPages(); }} class="p-2 text-neutral-400 hover:text-red-400 rounded-xl" title="Clear Page"><Trash2 size={16} /></button>
      </div>

      <!-- Musical Symbols Sub-Toolbar (When Stamp Selected) -->
      {#if activeTool === 'stamp'}
        <div class="flex items-center gap-1.5 pt-2 border-t border-neutral-800 overflow-x-auto max-w-full">
          {#each MUSICAL_SYMBOLS as item}
            <button
              onclick={() => selectedSymbol = item.symbol}
              class="px-2.5 py-1 rounded-lg border text-sm font-serif transition flex items-center justify-center min-w-[32px]
              {selectedSymbol === item.symbol ? 'bg-purple-600/30 border-purple-500 text-purple-200' : 'bg-neutral-950 border-neutral-800 text-neutral-300 hover:bg-neutral-800'}"
              title={item.label}>
              {item.symbol}
            </button>
          {/each}
        </div>
      {/if}

    </div>
  {/if}

  <!-- Footer Navigation -->
  <footer class="p-3 flex justify-center z-20">
    <div class="bg-neutral-900/90 backdrop-blur-xl border border-neutral-800 px-6 py-2 rounded-2xl shadow-2xl flex items-center gap-6">
      <div class="flex items-center gap-2">
        <button disabled={currentPage <= 1} onclick={() => goToPage(currentPage - (isDualPage ? 2 : 1))} class="p-2 bg-neutral-800 disabled:opacity-30 rounded-xl hover:bg-neutral-700 transition"><ChevronLeft size={18} /></button>
        <span class="text-xs font-semibold text-neutral-300 min-w-[90px] text-center">
          {currentPage} {isDualPage && currentPage + 1 <= totalPages ? `- ${currentPage + 1}` : ''} / {totalPages}
        </span>
        <button disabled={currentPage >= totalPages} onclick={() => goToPage(currentPage + (isDualPage ? 2 : 1))} class="p-2 bg-neutral-800 disabled:opacity-30 rounded-xl hover:bg-neutral-700 transition"><ChevronRight size={18} /></button>
      </div>

      <div class="h-5 w-px bg-neutral-800"></div>

      <button
        onclick={() => isAnnotationToolOpen = !isAnnotationToolOpen}
        class="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold transition cursor-pointer
        {isAnnotationToolOpen ? 'bg-blue-600 text-white shadow-lg shadow-blue-600/30' : 'bg-neutral-800 text-neutral-300 hover:bg-neutral-700'}">
        <Pencil size={16} />
        <span>Annotate Palette</span>
      </button>
    </div>
  </footer>

</div>
