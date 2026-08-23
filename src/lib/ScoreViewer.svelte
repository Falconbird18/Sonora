<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as pdfjsLib from 'pdfjs-dist';
	import { db } from './db';
	import type { ScoreItem, Stroke, SymbolStamp, TextNote } from './types';
	import {
		ArrowLeft, ChevronLeft, ChevronRight, PenTool, Highlighter, Eraser, Type,
		Undo2, Redo2, ZoomIn, ZoomOut, MousePointer2, Minus, ArrowUpRight,
		BookOpen, Maximize2, Minimize2, Settings2, MoreHorizontal, RotateCcw,
		PanelLeft, X, Trash2, Check, Bookmark, BookmarkCheck
	} from 'lucide-svelte';

	let { score, onClose }: { score: ScoreItem; onClose: () => void } = $props();
	type Tool = 'move' | 'pen' | 'highlighter' | 'eraser' | 'text' | 'line' | 'arrow' | 'sharp' | 'flat' | 'natural';
	type FitMode = 'page' | 'width' | 'height' | 'free';
	type Snapshot = { strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[] };

	let pdfDoc = $state<pdfjsLib.PDFDocumentProxy | null>(null);
	let current = $state(1);
	let dual = $state(false);
	let zoom = $state(1);
	let fitMode = $state<FitMode>('page');
	let tool = $state<Tool>('move');
	let color = $state('#ef4444');
	let strokeWidth = $state(3);
	let annotations = $state<Record<number, Stroke[]>>({});
	let stamps = $state<Record<number, SymbolStamp[]>>({});
	let notes = $state<Record<number, TextNote[]>>({});
	let history = $state<Record<number, Snapshot[]>>({});
	let historyIndex = $state<Record<number, number>>({});
	let annotationOpen = $state(false);
	let readingMode = $state(false);
	let settingsOpen = $state(false);
	let moreOpen = $state(false);
	let showPageShadow = $state(true);
	let autoHide = $state(true);
	let compactControls = $state(false);
	let showNotes = $state(true);
	let bookmarked = $state(false);
	let host = $state<HTMLElement | null>(null);
	let leftPdf = $state<HTMLCanvasElement | null>(null);
	let rightPdf = $state<HTMLCanvasElement | null>(null);
	let leftInk = $state<HTMLCanvasElement | null>(null);
	let rightInk = $state<HTMLCanvasElement | null>(null);
	let renderId = 0;
	let resizeTimer: ReturnType<typeof setTimeout> | undefined;
	let pageInput = $state('1');
	let controlsVisible = $state(true);

	const colors = ['#ef4444', '#2563eb', '#16a34a', '#eab308', '#9333ea', '#111827'];

	onMount(() => {
		loadScore();
		const saved = localStorage.getItem(`sonora-viewer-${score.id}`);
		if (saved) {
			try {
				const s = JSON.parse(saved);
				bookmarked = !!s.bookmarked;
				zoom = typeof s.zoom === 'number' ? s.zoom : 1;
				dual = !!s.dual;
			} catch {}
		}
		return () => pdfDoc?.destroy();
	});

	async function loadScore() {
		const data = new Uint8Array(await score.pdfBlob.arrayBuffer());
		pdfDoc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
		const records = await db.annotations.where('scoreId').equals(score.id).toArray();
		for (const r of records) {
			annotations[r.pageNum] = r.strokes || [];
			stamps[r.pageNum] = r.stamps || [];
			notes[r.pageNum] = r.notes || [];
			history[r.pageNum] = [snapshot(r.pageNum)];
			historyIndex[r.pageNum] = 0;
		}
		await tick();
		renderPages();
	}

	function snapshot(p: number): Snapshot {
		return $state.snapshot({ strokes: annotations[p] || [], stamps: stamps[p] || [], notes: notes[p] || [] });
	}

	function checkpoint(p: number) {
		const h = history[p] || [];
		const i = historyIndex[p] ?? -1;
		const next = [...h.slice(0, i + 1), snapshot(p)].slice(-60);
		history[p] = next;
		historyIndex[p] = next.length - 1;
		save(p);
	}

	function save(p: number) {
		void db.annotations.put($state.snapshot({
			id: `${score.id}_page_${p}`,
			scoreId: score.id,
			pageNum: p,
			strokes: annotations[p] || [],
			stamps: stamps[p] || [],
			notes: notes[p] || []
		}));
	}

	function persistViewer() {
		localStorage.setItem(`sonora-viewer-${score.id}`, JSON.stringify({ bookmarked, zoom, dual }));
	}

	async function renderPages() {
		renderId++;
		const id = renderId;
		if (!pdfDoc) return;
		if (dual && (host?.clientWidth || 0) < 760) dual = false;
		if (dual) {
			const l = current % 2 === 0 ? current : Math.max(1, current - 1);
			const r = l + 1;
			await Promise.all([
				renderOne(l, leftPdf, leftInk, id),
				r <= pdfDoc.numPages ? renderOne(r, rightPdf, rightInk, id) : Promise.resolve()
			]);
		} else await renderOne(current, leftPdf, leftInk, id);
	}

	async function renderOne(p: number, pdf: HTMLCanvasElement | null, ink: HTMLCanvasElement | null, id: number) {
		if (!pdfDoc || !pdf || !ink || !host) return;
		const page = await pdfDoc.getPage(p);
		if (id !== renderId) return;
		const base = page.getViewport({ scale: 1 });
		const gap = dual ? 32 : 24;
		const availableW = Math.max(280, dual ? (host.clientWidth - gap - 48) / 2 : host.clientWidth - 48);
		const availableH = Math.max(280, host.clientHeight - 48);
		let scale = fitMode === 'width' ? availableW / base.width : fitMode === 'height' ? availableH / base.height : Math.min(availableW / base.width, availableH / base.height);
		if (fitMode === 'free') scale *= zoom;
		else scale *= zoom;
		const maxPixels = 12_000_000;
		if (base.width * scale * base.height * scale > maxPixels) scale = Math.sqrt(maxPixels / (base.width * base.height));
		scale = Math.max(0.2, Math.min(3.0, scale));
		const viewport = page.getViewport({ scale });
		const w = Math.ceil(viewport.width), h = Math.ceil(viewport.height), dpr = Math.min(window.devicePixelRatio || 1, 2);
		pdf.width = w * dpr; pdf.height = h * dpr; ink.width = w * dpr; ink.height = h * dpr;
		pdf.style.width = ink.style.width = `${w}px`; pdf.style.height = ink.style.height = `${h}px`;
		const ctxPdf = pdf.getContext('2d')!; ctxPdf.setTransform(dpr, 0, 0, dpr, 0, 0);
		const ctxInk = ink.getContext('2d')!; ctxInk.setTransform(dpr, 0, 0, dpr, 0, 0);
		await page.render({ canvasContext: ctxPdf, viewport }).promise;
		if (id === renderId) redraw(p, ink);
	}

	function norm(p: { x: number; y: number; pressure?: number }, c: HTMLCanvasElement) {
		const r = c.getBoundingClientRect();
		return p.x > 2 || p.y > 2 ? { x: p.x / r.width, y: p.y / r.height, pressure: p.pressure } : p;
	}
	function xy(p: { x: number; y: number; pressure?: number }, c: HTMLCanvasElement) {
		const n = norm(p, c), r = c.getBoundingClientRect();
		return { x: n.x * r.width, y: n.y * r.height };
	}
	function drawSegment(ctx: CanvasRenderingContext2D, a: any, b: any, c: HTMLCanvasElement, s: Stroke) {
		const p1 = xy(a, c), p2 = xy(b, c); ctx.beginPath(); ctx.moveTo(p1.x, p1.y); ctx.lineTo(p2.x, p2.y);
		ctx.strokeStyle = s.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = s.width * (a.pressure ? 0.65 + a.pressure * 0.7 : 1); ctx.stroke();
	}
	function drawShape(ctx: CanvasRenderingContext2D, s: Stroke, c: HTMLCanvasElement) {
		if (s.points.length < 2) return; const a = xy(s.points[0], c), b = xy(s.points[s.points.length - 1], c);
		ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.strokeStyle = s.color; ctx.lineWidth = s.width; ctx.lineCap = 'round'; ctx.stroke();
		if (s.kind === 'arrow') { const angle = Math.atan2(b.y - a.y, b.x - a.x), head = Math.max(8, s.width * 4); ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(angle - Math.PI / 6), b.y - head * Math.sin(angle - Math.PI / 6)); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(angle + Math.PI / 6), b.y - head * Math.sin(angle + Math.PI / 6)); ctx.stroke(); }
	}
	function redraw(p: number, c: HTMLCanvasElement | null = pageCanvas(p)) {
		if (!c) return; const ctx = c.getContext('2d')!; const r = c.getBoundingClientRect(); ctx.clearRect(0, 0, r.width, r.height);
		for (const s of annotations[p] || []) {
			if (s.tool === 'highlighter' || s.kind === 'highlighter') {
				if (s.points.length < 2) continue; ctx.save(); ctx.beginPath(); const a = xy(s.points[0], c); ctx.moveTo(a.x, a.y);
				for (let i = 1; i < s.points.length; i++) { const q = xy(s.points[i], c); ctx.lineTo(q.x, q.y); }
				ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.globalCompositeOperation = 'multiply'; ctx.strokeStyle = s.color + '77'; ctx.lineWidth = Math.max(12, s.width * 5); ctx.stroke(); ctx.restore();
			} else if (s.kind === 'line' || s.kind === 'arrow') drawShape(ctx, s, c);
			else for (let i = 1; i < s.points.length; i++) drawSegment(ctx, s.points[i - 1], s.points[i], c, s);
		}
		for (const s of stamps[p] || []) { const q = xy({ x: s.x, y: s.y }, c); ctx.save(); ctx.font = `${s.fontSize}px Leland, serif`; ctx.fillStyle = s.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s.symbol, q.x, q.y); ctx.restore(); }
	}
	function pageCanvas(p: number) {
		if (!dual) return leftInk;
		const l = current % 2 === 0 ? current : Math.max(1, current - 1); return p === l ? leftInk : rightInk;
	}
	function pagePoint(e: PointerEvent, c: HTMLCanvasElement) { const r = c.getBoundingClientRect(); return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height, pressure: e.pressure || 0.5 }; }

	function start(e: PointerEvent, p: number, c: HTMLCanvasElement) {
		if (tool === 'move' || !annotationOpen || readingMode) return; e.preventDefault(); c.setPointerCapture(e.pointerId); const pt = pagePoint(e, c);
		if (tool === 'eraser') eraseAt(pt, p, c);
		else if (tool === 'sharp' || tool === 'flat' || tool === 'natural') {
			const map = { sharp: '♯', flat: '♭', natural: '♮' } as const; (stamps[p] ||= []).push({ id: crypto.randomUUID(), x: pt.x, y: pt.y, symbol: map[tool], label: tool, color, fontSize: 32 }); checkpoint(p); redraw(p, c);
		} else if (tool === 'text') {
			const n: TextNote = { id: crypto.randomUUID(), x: pt.x, y: pt.y, text: '', color, fontSize: 16 }; (notes[p] ||= []).push(n); save(p); setTimeout(() => document.getElementById(`note-${n.id}`)?.focus(), 40);
		} else {
			const kind = tool === 'highlighter' ? 'highlighter' : tool === 'line' ? 'line' : tool === 'arrow' ? 'arrow' : 'freehand';
			const s: Stroke = { id: crypto.randomUUID(), tool: tool === 'highlighter' ? 'highlighter' : 'pen', color, width: strokeWidth, points: [pt], kind }; (annotations[p] ||= []).push(s);
			const move = (me: PointerEvent) => { const q = pagePoint(me, c); s.points.push(q); if (kind !== 'freehand') redraw(p, c); else drawSegment(c.getContext('2d')!, s.points[s.points.length - 2], q, c, s); };
			const finish = () => { c.removeEventListener('pointermove', move); c.removeEventListener('pointerup', finish); c.removeEventListener('pointercancel', finish); try { c.releasePointerCapture(e.pointerId); } catch {} if (s.points.length > 1) checkpoint(p); redraw(p, c); };
			c.addEventListener('pointermove', move); c.addEventListener('pointerup', finish); c.addEventListener('pointercancel', finish);
		}
	}

	function eraseAt(pt: { x: number; y: number }, p: number, c: HTMLCanvasElement) {
		const radius = Math.max(0.012, strokeWidth / 1000); let changed = false;
		if (annotations[p]) { const before = annotations[p].length; annotations[p] = annotations[p].filter(s => !s.points.some(q => Math.hypot(q.x - pt.x, q.y - pt.y) < radius)); changed ||= before !== annotations[p].length; }
		if (stamps[p]) { const before = stamps[p].length; stamps[p] = stamps[p].filter(s => Math.hypot(s.x - pt.x, s.y - pt.y) > radius * 1.8); changed ||= before !== stamps[p].length; }
		if (changed) { checkpoint(p); redraw(p, c); }
	}

	function restore(p: number, s: Snapshot) { annotations[p] = JSON.parse(JSON.stringify(s.strokes)); stamps[p] = JSON.parse(JSON.stringify(s.stamps)); notes[p] = JSON.parse(JSON.stringify(s.notes)); save(p); redraw(p); }
	function undo() { const p = current, i = historyIndex[p] ?? 0; if (i <= 0) return; historyIndex[p] = i - 1; restore(p, history[p][i - 1]); }
	function redo() { const p = current, i = historyIndex[p] ?? 0; if (!history[p] || i >= history[p].length - 1) return; historyIndex[p] = i + 1; restore(p, history[p][i + 1]); }
	function nav(delta: number) { const max = pdfDoc?.numPages || 1, step = dual ? 2 : 1, next = current + delta * step; if (next >= 1 && next <= max) { current = next; pageInput = String(next); renderPages(); } }
	function goToPage() { const max = pdfDoc?.numPages || 1, n = Math.max(1, Math.min(max, Number(pageInput) || 1)); current = n; pageInput = String(n); renderPages(); }
	function setZoom(v: number) { zoom = Math.max(0.5, Math.min(2.5, v)); fitMode = 'free'; persistViewer(); renderPages(); }
	function fit(mode: FitMode) { fitMode = mode; if (mode !== 'free') zoom = 1; renderPages(); }
	function toggleBookmark() { bookmarked = !bookmarked; persistViewer(); }
	function deleteNote(p: number, id: string) { notes[p] = (notes[p] || []).filter(n => n.id !== id); checkpoint(p); }
	function key(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
		if (e.key === 'Escape') { settingsOpen = false; moreOpen = false; if (readingMode) readingMode = false; }
		else if (e.key === 'ArrowRight' || e.key === 'PageDown' || e.key === ' ') { e.preventDefault(); nav(1); }
		else if (e.key === 'ArrowLeft' || e.key === 'PageUp') { e.preventDefault(); nav(-1); }
		else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); }
		else if (e.key.toLowerCase() === 'p') { annotationOpen = true; tool = 'pen'; }
		else if (e.key.toLowerCase() === 'h') { annotationOpen = true; tool = 'highlighter'; }
		else if (e.key.toLowerCase() === 'e') { annotationOpen = true; tool = 'eraser'; }
		else if (e.key.toLowerCase() === 'r') readingMode = true;
	}
</script>

<svelte:window onkeydown={key} onresize={() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderPages, 180); }} />

<div class="fixed inset-0 z-50 flex flex-col overflow-hidden bg-[#11110f] text-neutral-100 font-sans selection:bg-violet-500/30">
	{#if controlsVisible && !readingMode}
		<header class="shrink-0 h-16 border-b border-white/8 bg-[#171714]/95 backdrop-blur-xl flex items-center justify-between gap-3 px-3 sm:px-5 shadow-lg shadow-black/10">
			<div class="flex items-center gap-2 min-w-0 flex-1">
				<button class="h-11 w-11 shrink-0 rounded-2xl flex items-center justify-center text-neutral-300 hover:bg-white/8 active:scale-95 transition" onclick={onClose} title="Back to library"><ArrowLeft size={20}/></button>
				<div class="min-w-0 hidden sm:block">
					<h1 class="font-semibold text-sm truncate">{score.title}</h1><p class="text-xs text-neutral-500 truncate">{score.composer}</p>
				</div>
			</div>
			<div class="flex items-center gap-1.5 bg-[#0d0d0b] border border-white/8 rounded-2xl p-1">
				<button class="h-10 w-10 rounded-xl hover:bg-white/8 disabled:opacity-30" disabled={current <= 1} onclick={() => nav(-1)}><ChevronLeft size={20}/></button>
				<button class="h-10 px-2 min-w-[78px] rounded-xl hover:bg-white/8 flex items-center justify-center gap-1" onclick={() => pageInput = String(current)}><span class="text-sm tabular-nums">{current}</span><span class="text-xs text-neutral-500">/ {pdfDoc?.numPages || '…'}</span></button>
				<button class="h-10 w-10 rounded-xl hover:bg-white/8 disabled:opacity-30" disabled={current >= (pdfDoc?.numPages || 1)} onclick={() => nav(1)}><ChevronRight size={20}/></button>
			</div>
			<div class="flex items-center justify-end gap-1.5 flex-1">
				<button class="h-11 w-11 rounded-2xl flex items-center justify-center transition {bookmarked ? 'bg-amber-500/15 text-amber-400' : 'text-neutral-400 hover:bg-white/8'}" onclick={toggleBookmark} title="Bookmark score">{#if bookmarked}<BookmarkCheck size={19}/>{:else}<Bookmark size={19}/>{/if}</button>
				<button class="h-11 w-11 rounded-2xl flex items-center justify-center {annotationOpen ? 'bg-violet-600 text-white' : 'text-neutral-300 hover:bg-white/8'}" onclick={() => { annotationOpen = !annotationOpen; moreOpen = false; }} title="Annotations"><PenTool size={19}/></button>
				<button class="h-11 w-11 rounded-2xl hidden sm:flex items-center justify-center text-neutral-300 hover:bg-white/8" onclick={() => dual = !dual} title="Two-page view"><BookOpen size={19}/></button>
				<button class="h-11 w-11 rounded-2xl flex items-center justify-center text-neutral-300 hover:bg-white/8" onclick={() => readingMode = true} title="Reading mode"><Maximize2 size={18}/></button>
				<button class="h-11 w-11 rounded-2xl flex items-center justify-center {settingsOpen ? 'bg-white/10 text-white' : 'text-neutral-300 hover:bg-white/8'}" onclick={() => settingsOpen = !settingsOpen}><Settings2 size={19}/></button>
			</div>
		</header>
	{/if}

	{#if controlsVisible && !readingMode}
		<div class="absolute top-[4.25rem] right-3 sm:right-5 z-40 w-[min(360px,calc(100vw-24px))] rounded-3xl border border-white/10 bg-[#1a1a17]/98 backdrop-blur-2xl shadow-2xl shadow-black/40 p-4 transition-all">
			{#if settingsOpen}
				<div class="flex items-center justify-between mb-3"><div><h2 class="font-semibold">Viewer settings</h2><p class="text-xs text-neutral-500">Tune the score for your screen.</p></div><button class="p-2 rounded-xl hover:bg-white/8" onclick={() => settingsOpen = false}><X size={17}/></button></div>
				<div class="space-y-4 text-sm">
					<div><p class="text-xs text-neutral-500 mb-2">Page layout</p><div class="grid grid-cols-3 gap-1.5">{#each [['page','Page'],['width','Width'],['height','Height']] as [id,label]}<button class="rounded-xl py-2.5 border {fitMode === id ? 'border-violet-500 bg-violet-500/15 text-violet-200' : 'border-white/8 bg-white/5 text-neutral-400'}" onclick={() => fit(id as FitMode)}>{label}</button>{/each}</div></div>
					<label class="flex items-center justify-between"><span>Two-page view</span><input type="checkbox" bind:checked={dual} onchange={renderPages}/></label>
					<label class="flex items-center justify-between"><span>Page shadows</span><input type="checkbox" bind:checked={showPageShadow}/></label>
					<label class="flex items-center justify-between"><span>Show text notes</span><input type="checkbox" bind:checked={showNotes}/></label>
					<label class="flex items-center justify-between"><span>Compact controls</span><input type="checkbox" bind:checked={compactControls}/></label>
					<label class="flex items-center justify-between"><span>Auto-hide controls in reading mode</span><input type="checkbox" bind:checked={autoHide}/></label>
				</div>
			{:else}
				<div class="flex items-center justify-between mb-3"><span class="font-semibold">Score tools</span><button class="p-2 rounded-xl hover:bg-white/8" onclick={() => moreOpen = !moreOpen}><MoreHorizontal size={18}/></button></div>
				<div class="flex items-center gap-2"><button class="flex-1 py-2.5 rounded-xl bg-white/7 hover:bg-white/10" onclick={() => setZoom(zoom - .1)}><ZoomOut size={16} class="inline mr-1"/>Zoom out</button><button class="flex-1 py-2.5 rounded-xl bg-white/7 hover:bg-white/10" onclick={() => setZoom(zoom + .1)}><ZoomIn size={16} class="inline mr-1"/>Zoom in</button></div>
				<div class="grid grid-cols-2 gap-2 mt-2"><button class="py-2.5 rounded-xl bg-white/7 hover:bg-white/10" onclick={() => fit('page')}>Fit page</button><button class="py-2.5 rounded-xl bg-white/7 hover:bg-white/10" onclick={() => { zoom = 1; fitMode = 'page'; renderPages(); }}>Reset</button></div>
			{/if}
		</div>
	{/if}

	{#if controlsVisible && !readingMode && annotationOpen}
		<div class="absolute z-30 left-1/2 -translate-x-1/2 bottom-4 sm:bottom-6 flex items-center gap-1.5 rounded-3xl border border-white/10 bg-[#191916]/96 backdrop-blur-2xl shadow-2xl shadow-black/40 p-2 max-w-[calc(100vw-20px)] overflow-x-auto">
			{@render toolBtn('move', MousePointer2, 'Move')}{@render toolBtn('pen', PenTool, 'Pen')}{@render toolBtn('highlighter', Highlighter, 'Highlight')}{@render toolBtn('line', Minus, 'Line')}{@render toolBtn('arrow', ArrowUpRight, 'Arrow')}{@render toolBtn('text', Type, 'Text')}{@render toolBtn('eraser', Eraser, 'Erase')}
			<div class="w-px h-7 bg-white/10 mx-1 shrink-0"></div>
			{#each ['sharp','flat','natural'] as stamp}<button class="h-11 min-w-11 px-2 rounded-2xl text-lg {tool === stamp ? 'bg-violet-600 text-white' : 'text-neutral-300 hover:bg-white/8'}" onclick={() => tool = stamp as Tool}>{stamp === 'sharp' ? '♯' : stamp === 'flat' ? '♭' : '♮'}</button>{/each}
			<div class="w-px h-7 bg-white/10 mx-1 shrink-0"></div>
			{#each colors as c}<button class="h-7 w-7 rounded-full shrink-0 ring-2 ring-offset-2 ring-offset-[#191916] {color === c ? 'ring-white' : 'ring-transparent'}" style:background-color={c} onclick={() => color = c}></button>{/each}
			<input aria-label="Pen width" type="range" min="1" max="12" step="1" bind:value={strokeWidth} class="w-20 accent-violet-500 ml-1" />
			<button class="h-11 w-11 rounded-2xl text-neutral-300 hover:bg-white/8 shrink-0" onclick={undo} disabled={(historyIndex[current] ?? 0) <= 0}><Undo2 size={18}/></button>
			<button class="h-11 w-11 rounded-2xl text-neutral-300 hover:bg-white/8 shrink-0" onclick={redo} disabled={!history[current] || (historyIndex[current] ?? 0) >= history[current].length - 1}><Redo2 size={18}/></button>
		</div>
	{/if}

	<main bind:this={host} class="flex-1 min-h-0 overflow-auto relative bg-[radial-gradient(circle_at_top,#262620_0%,#11110f_55%)] flex items-center justify-center p-3 sm:p-6 {readingMode ? 'cursor-none' : ''}" onclick={() => { if (readingMode && autoHide) controlsVisible = !controlsVisible; }}>
		<div class="flex items-center justify-center gap-4 sm:gap-8 min-h-full transition-all duration-300">
			<div class="relative bg-white rounded-sm overflow-hidden {showPageShadow ? 'shadow-[0_22px_60px_rgba(0,0,0,.5)]' : 'shadow-none'} ring-1 ring-black/20" style="touch-action:none">
				<canvas bind:this={leftPdf} class="block"></canvas>
				<canvas bind:this={leftInk} class="absolute inset-0 z-10 w-full h-full {tool === 'move' ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'}" onpointerdown={(e) => start(e, dual ? (current % 2 === 0 ? current : Math.max(1,current-1)) : current, leftInk!)}></canvas>
				{#if showNotes}
					<div class="absolute inset-0 z-20 pointer-events-none overflow-hidden">{#each notes[dual ? (current % 2 === 0 ? current : Math.max(1,current-1)) : current] || [] as n (n.id)}<div class="absolute pointer-events-auto group" style:left={`${n.x * 100}%`} style:top={`${n.y * 100}%`}><textarea id={`note-${n.id}`} bind:value={n.text} class="bg-amber-50/80 text-neutral-900 rounded-lg border border-amber-300/70 shadow-lg outline-none resize-none p-2 min-w-24 min-h-8" style:color={n.color} style:font-size={`${n.fontSize}px`} onblur={() => checkpoint(current)} placeholder="Note…"></textarea><button class="absolute -right-2 -top-2 hidden group-hover:flex w-6 h-6 rounded-full bg-red-500 text-white items-center justify-center" onclick={() => deleteNote(current,n.id)}><Trash2 size={12}/></button></div>{/each}</div>
				{/if}
			</div>
			{#if dual && (current % 2 === 0 ? current + 1 : current + 2) <= (pdfDoc?.numPages || 1)}
				<div class="relative bg-white rounded-sm overflow-hidden {showPageShadow ? 'shadow-[0_22px_60px_rgba(0,0,0,.5)]' : 'shadow-none'} ring-1 ring-black/20 hidden md:block" style="touch-action:none"><canvas bind:this={rightPdf} class="block"></canvas><canvas bind:this={rightInk} class="absolute inset-0 z-10 w-full h-full cursor-crosshair" onpointerdown={(e) => start(e, current % 2 === 0 ? current + 1 : current + 1, rightInk!)}></canvas></div>
			{/if}
		</div>
	</main>

	{#if !controlsVisible || readingMode}
		<button class="absolute z-50 top-3 left-3 h-11 w-11 rounded-2xl bg-black/45 backdrop-blur text-white flex items-center justify-center border border-white/10" onclick={() => { controlsVisible = true; readingMode = false; }} title="Show controls"><PanelLeft size={18}/></button>
	{/if}

	{#if controlsVisible && !readingMode}
		<footer class="shrink-0 h-12 border-t border-white/7 bg-[#171714]/95 backdrop-blur-xl flex items-center justify-between px-3 sm:px-5 text-xs text-neutral-500">
			<div class="flex items-center gap-2"><span class="hidden sm:inline">{score.totalPages} pages</span><span class="text-neutral-700 hidden sm:inline">•</span><span>{Math.round(zoom * 100)}%</span></div>
			<div class="flex items-center gap-1.5"><form onsubmit={(e) => { e.preventDefault(); goToPage(); }} class="flex items-center gap-1"><input bind:value={pageInput} aria-label="Page number" inputmode="numeric" class="w-12 h-8 text-center rounded-lg bg-white/5 border border-white/8 text-neutral-200 outline-none focus:border-violet-500"/><span>/ {pdfDoc?.numPages || '…'}</span></form><button class="h-8 px-2 rounded-lg hover:bg-white/7" onclick={() => fit('page')}>Fit</button></div>
		</footer>
	{/if}
</div>

{#snippet toolBtn(id: Tool, Icon: any, label: string)}
	<button class="h-11 px-2.5 min-w-11 rounded-2xl flex items-center justify-center gap-1.5 shrink-0 transition {tool === id ? 'bg-violet-600 text-white shadow-lg shadow-violet-900/30' : 'text-neutral-300 hover:bg-white/8'}" onclick={() => tool = id} title={label}><Icon size={18}/><span class="hidden lg:inline text-xs">{label}</span></button>
{/snippet}
