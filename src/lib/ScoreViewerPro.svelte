<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as pdfjsLib from 'pdfjs-dist';
	import { db } from './db';
	import type { ScoreItem, Stroke, SymbolStamp, TextNote, Point } from './types';
	import { MUSIC_SYMBOLS, MUSIC_SYMBOL_CATEGORIES, type MusicSymbol } from './musicSymbols';
	import { ArrowLeft, ChevronLeft, ChevronRight, PenTool, Highlighter, Eraser, Type, Undo2, Redo2, ZoomIn, ZoomOut, MousePointer2, Minus, ArrowUpRight, Maximize2, PanelLeft, X, Trash2, Bookmark, BookmarkCheck, Settings2, Grid3X3, Timer, Mic2, RotateCcw, Download, Search, Eye, EyeOff, Play, Pause, Volume2 } from 'lucide-svelte';

	let { score, onClose }: { score: ScoreItem; onClose: () => void } = $props();
	type Tool = 'move' | 'pen' | 'highlighter' | 'eraser' | 'text' | 'line' | 'arrow' | 'symbol';
	type FitMode = 'page' | 'width' | 'height' | 'free';
	type Snapshot = { strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[] };
	type RenderTarget = { pdf: HTMLCanvasElement | null; ink: HTMLCanvasElement | null };

	class BlobRangeTransport extends pdfjsLib.PDFDataRangeTransport {
		private blob: Blob;
		private pending = new Map<string, Promise<void>>();
		constructor(blob: Blob) { super(blob.size, null, false, 'score.pdf'); this.blob = blob; }
		requestDataRange(begin: number, end: number) {
			const key = `${begin}:${end}`;
			if (this.pending.has(key)) return;
			const request = this.blob.slice(begin, end).arrayBuffer()
				.then(buffer => { this.onDataRange(begin, new Uint8Array(buffer)); this.onDataProgress(end); })
				.catch(error => this.abort(error));
			this.pending.set(key, request);
			void request.finally(() => this.pending.delete(key));
		}
		abort(_reason?: unknown) { this.pending.clear(); }
	}

	let pdfDoc = $state<pdfjsLib.PDFDocumentProxy | null>(null);
	let transport: BlobRangeTransport | null = null;
	let current = $state(1);
	let zoom = $state(1);
	let fit = $state<FitMode>('page');
	let dual = $state(false);
	let thumbnails = $state(false);
	let controls = $state(true);
	let reading = $state(false);
	let settingsOpen = $state(false);
	let symbolsOpen = $state(false);
	let utility = $state<'none' | 'metronome' | 'tuner'>('none');
	let annotationOpen = $state(false);
	let annotationsVisible = $state(true);
	let pageInput = $state('1');
	let searchOpen = $state(false);
	let searchText = $state('');
	let bookmarked = $state(false);
	let color = $state('#ef4444');
	let width = $state(3);
	let tool = $state<Tool>('move');
	let selectedSymbol: MusicSymbol | null = $state(null);
	let symbolCategory = $state<typeof MUSIC_SYMBOL_CATEGORIES[number]>('Accidentals');
	let annotations = $state<Record<number, Stroke[]>>({});
	let stamps = $state<Record<number, SymbolStamp[]>>({});
	let notes = $state<Record<number, TextNote[]>>({});
	let history = $state<Record<number, Snapshot[]>>({});
	let historyIndex = $state<Record<number, number>>({});
	let host = $state<HTMLElement | null>(null);
	let leftPdf = $state<HTMLCanvasElement | null>(null);
	let rightPdf = $state<HTMLCanvasElement | null>(null);
	let leftInk = $state<HTMLCanvasElement | null>(null);
	let rightInk = $state<HTMLCanvasElement | null>(null);
	let busy = $state(false);
	let error = $state('');
	let renderGeneration = 0;
	let renderTasks: pdfjsLib.RenderTask[] = [];
	let resizeTimer: ReturnType<typeof setTimeout> | undefined;
	let saveTimer: ReturnType<typeof setTimeout> | undefined;
	let drawing: { page: number; canvas: HTMLCanvasElement; stroke?: Stroke; pointerId: number; raf?: number } | null = null;

	let metroBpm = $state(80), metroRunning = $state(false), metroBeat = $state(0);
	let metroTimer: ReturnType<typeof setInterval> | undefined;
	let audio: AudioContext | null = null;
	let tunerRunning = $state(false), tunerNote = $state('--'), tunerCents = $state(0), tunerHz = $state(0), tunerError = $state('');
	let stream: MediaStream | null = null, analyser: AnalyserNode | null = null, tunerFrame = 0;

	const colors = ['#ef4444', '#2563eb', '#16a34a', '#eab308', '#9333ea', '#111827'];
	const maxCanvasPixels = 8_000_000;
	const pageNumbers = $derived(dual ? [Math.max(1, current % 2 === 0 ? current : current - 1), current % 2 === 0 ? current + 1 : current + 1] : [current]);
	const currentHistory = $derived(history[current] || []);
	const currentHistoryIndex = $derived(historyIndex[current] ?? 0);
	const currentSymbols = $derived(MUSIC_SYMBOLS.filter(s => s.category === symbolCategory));

	onMount(() => {
		void load();
		const saved = localStorage.getItem(`sonora-viewer-v2-${score.id}`);
		if (saved) try {
			const s = JSON.parse(saved);
			bookmarked = !!s.bookmarked;
			dual = !!s.dual;
			zoom = typeof s.zoom === 'number' ? s.zoom : 1;
			annotationsVisible = s.annotationsVisible !== false;
		} catch {}
		const onKey = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			if (e.key === 'ArrowRight') next();
			else if (e.key === 'ArrowLeft') previous();
			else if (e.key === '+' || e.key === '=') setZoom(zoom + .1);
			else if (e.key === '-') setZoom(zoom - .1);
			else if (e.key === 'Escape') { settingsOpen = false; symbolsOpen = false; searchOpen = false; }
			else if (e.key.toLowerCase() === 'p') chooseTool('pen');
			else if (e.key.toLowerCase() === 'h') chooseTool('highlighter');
			else if (e.key.toLowerCase() === 'e') chooseTool('eraser');
			else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
			else if ((e.ctrlKey || e.metaKey) && (e.key.toLowerCase() === 'y' || (e.shiftKey && e.key.toLowerCase() === 'z'))) { e.preventDefault(); redo(); }
		};
		window.addEventListener('keydown', onKey);
		const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => void render(), 100); });
		if (host) observer.observe(host);
		return () => { window.removeEventListener('keydown', onKey); observer.disconnect(); clearTimeout(resizeTimer); clearTimeout(saveTimer); cancelRenders(); transport?.abort(); void pdfDoc?.destroy(); stopMetronome(); stopTuner(); if (audio) void audio.close(); };
	});

	async function load() {
		busy = true; error = '';
		try {
			transport = new BlobRangeTransport(score.pdfBlob);
			pdfDoc = await pdfjsLib.getDocument({ range: transport, rangeChunkSize: 512 * 1024, disableStream: true, disableAutoFetch: false, isEvalSupported: false }).promise;
			const records = await db.annotations.where('scoreId').equals(score.id).toArray();
			for (const record of records) {
				annotations[record.pageNum] = record.strokes || [];
				stamps[record.pageNum] = record.stamps || [];
				notes[record.pageNum] = record.notes || [];
				history[record.pageNum] = [snapshot(record.pageNum)];
				historyIndex[record.pageNum] = 0;
			}
			await tick();
			await render();
		} catch (e) { console.error(e); error = 'Sonora could not render this PDF. Try reopening it or re-importing the file.'; }
		finally { busy = false; }
	}

	function cancelRenders() { for (const task of renderTasks) try { task.cancel(); } catch {} renderTasks = []; }
	async function render() {
		if (!pdfDoc) return;
		cancelRenders();
		const generation = ++renderGeneration;
		busy = true; error = '';
		try {
			if (dual && (host?.clientWidth || 0) < 780) dual = false;
			const pages = dual ? [Math.max(1, current % 2 === 0 ? current : current - 1), Math.min(pdfDoc.numPages, (current % 2 === 0 ? current : current - 1) + 1)] : [current];
			await Promise.all(pages.map((p, i) => renderPage(p, i === 0 ? { pdf: leftPdf, ink: leftInk } : { pdf: rightPdf, ink: rightInk }, generation)));
		} catch (e) {
			if (e instanceof Error && e.name === 'RenderingCancelledException') return;
			console.error(e); if (generation === renderGeneration) error = 'The page could not be rendered at this size. Try Fit Page or reduce zoom.';
		} finally { if (generation === renderGeneration) busy = false; }
	}

	async function renderPage(pageNumber: number, target: RenderTarget, generation: number) {
		if (!pdfDoc || !target.pdf || !target.ink || !host) return;
		const page = await pdfDoc.getPage(pageNumber);
		if (generation !== renderGeneration) return;
		const base = page.getViewport({ scale: 1 });
		const gap = dual ? 32 : 24;
		const availableW = Math.max(260, dual ? (host.clientWidth - gap - 64) / 2 : host.clientWidth - 64);
		const availableH = Math.max(260, host.clientHeight - 64);
		let scale = fit === 'width' ? availableW / base.width : fit === 'height' ? availableH / base.height : Math.min(availableW / base.width, availableH / base.height);
		if (fit === 'free') scale *= zoom; else scale *= zoom;
		if (base.width * scale * base.height * scale > maxCanvasPixels) scale = Math.sqrt(maxCanvasPixels / (base.width * base.height));
		scale = Math.max(.2, Math.min(3, scale));
		const viewport = page.getViewport({ scale });
		const w = Math.ceil(viewport.width), h = Math.ceil(viewport.height), dpr = Math.min(window.devicePixelRatio || 1, 2);
		for (const canvas of [target.pdf, target.ink]) { canvas.width = Math.ceil(w * dpr); canvas.height = Math.ceil(h * dpr); canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; }
		const ctx = target.pdf.getContext('2d', { alpha: false })!;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h);
		const task = page.render({ canvasContext: ctx, viewport });
		renderTasks.push(task);
		await task.promise;
		if (generation !== renderGeneration) return;
		redraw(pageNumber, target.ink);
	}

	function point(e: PointerEvent, c: HTMLCanvasElement): Point { const r = c.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)), pressure: e.pressure > 0 ? e.pressure : .5 }; }
	function screenPoint(p: Point, c: HTMLCanvasElement) { const r = c.getBoundingClientRect(); return { x: p.x * r.width, y: p.y * r.height }; }
	function drawSmooth(ctx: CanvasRenderingContext2D, points: Point[], c: HTMLCanvasElement) {
		if (!points.length) return;
		const first = screenPoint(points[0], c); ctx.beginPath(); ctx.moveTo(first.x, first.y);
		if (points.length === 1) { ctx.arc(first.x, first.y, 1, 0, Math.PI * 2); return; }
		for (let i = 1; i < points.length - 1; i++) { const a = screenPoint(points[i], c), b = screenPoint(points[i + 1], c); ctx.quadraticCurveTo(a.x, a.y, (a.x + b.x) / 2, (a.y + b.y) / 2); }
		const last = screenPoint(points[points.length - 1], c); ctx.quadraticCurveTo(last.x, last.y, last.x, last.y);
	}
	function redraw(page: number, canvas: HTMLCanvasElement | null) {
		if (!canvas) return;
		const ctx = canvas.getContext('2d')!, r = canvas.getBoundingClientRect(); ctx.clearRect(0, 0, r.width, r.height); if (!annotationsVisible) return;
		for (const s of annotations[page] || []) {
			ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.strokeStyle = s.color; ctx.lineWidth = s.tool === 'highlighter' ? Math.max(12, s.width * 5) : s.width;
			if (s.tool === 'highlighter') { ctx.globalAlpha = .38; ctx.globalCompositeOperation = 'multiply'; }
			if (s.kind === 'line' || s.kind === 'arrow') {
				const a = screenPoint(s.points[0], canvas), b = screenPoint(s.points[s.points.length - 1], canvas); ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
				if (s.kind === 'arrow') { const angle = Math.atan2(b.y - a.y, b.x - a.x), head = Math.max(10, s.width * 4); ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(angle - .5), b.y - head * Math.sin(angle - .5)); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(angle + .5), b.y - head * Math.sin(angle + .5)); ctx.stroke(); }
			} else { drawSmooth(ctx, s.points, canvas); ctx.stroke(); }
			ctx.restore();
		}
		for (const s of stamps[page] || []) { const p = screenPoint({ x: s.x, y: s.y }, canvas); ctx.save(); ctx.font = `${s.fontSize}px LelandText, Leland, 'Bravura', serif`; ctx.fillStyle = s.color; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(s.symbol, p.x, p.y); ctx.restore(); }
	}
	function canvasForPage(page: number) { if (!dual) return leftInk; const first = current % 2 === 0 ? current : current - 1; return page === first ? leftInk : rightInk; }

	function startDraw(e: PointerEvent, page: number, canvas: HTMLCanvasElement) {
		if (reading || !annotationOpen || tool === 'move') return;
		e.preventDefault(); canvas.setPointerCapture(e.pointerId); const p = point(e, canvas);
		if (tool === 'symbol') { if (selectedSymbol) placeSymbol(selectedSymbol, p, page, canvas); return; }
		if (tool === 'text') { const n: TextNote = { id: crypto.randomUUID(), x: p.x, y: p.y, text: '', color, fontSize: 16 }; (notes[page] ||= []).push(n); checkpoint(page); return; }
		if (tool === 'eraser') { drawing = { page, canvas, pointerId: e.pointerId }; erase(p, page, canvas); return; }
		const stroke: Stroke = { id: crypto.randomUUID(), tool: tool === 'highlighter' ? 'highlighter' : 'pen', kind: tool === 'line' ? 'line' : tool === 'arrow' ? 'arrow' : 'freehand', color, width, points: [p] };
		(annotations[page] ||= []).push(stroke); drawing = { page, canvas, pointerId: e.pointerId, stroke };
	}
	function moveDraw(e: PointerEvent) {
		if (!drawing) return;
		for (const ev of e.getCoalescedEvents?.() || [e]) {
			if (drawing.stroke) drawing.stroke.points.push(point(ev, drawing.canvas)); else erase(point(ev, drawing.canvas), drawing.page, drawing.canvas, false);
		}
		if (!drawing.raf) drawing.raf = requestAnimationFrame(() => { drawing && redraw(drawing.page, drawing.canvas); drawing = drawing ? { ...drawing, raf: undefined } : null; });
	}
	function endDraw() { if (!drawing) return; const d = drawing; if (d.raf) cancelAnimationFrame(d.raf); drawing = null; try { d.canvas.releasePointerCapture(d.pointerId); } catch {} redraw(d.page, d.canvas); checkpoint(d.page); }
	function erase(p: Point, page: number, canvas: HTMLCanvasElement, checkpointNow = true) { const radius = Math.max(.008, width / 950); const oldA = (annotations[page] || []).length, oldS = (stamps[page] || []).length; annotations[page] = (annotations[page] || []).filter(s => !s.points.some(q => Math.hypot(q.x - p.x, q.y - p.y) < radius)); stamps[page] = (stamps[page] || []).filter(s => Math.hypot(s.x - p.x, s.y - p.y) > radius * 2); if (oldA !== annotations[page].length || oldS !== stamps[page].length) { redraw(page, canvas); if (checkpointNow) checkpoint(page); } }

	function snapshot(page: number): Snapshot { return structuredClone({ strokes: annotations[page] || [], stamps: stamps[page] || [], notes: notes[page] || [] }); }
	function checkpoint(page: number) { const old = history[page] || []; const index = historyIndex[page] ?? -1; history[page] = [...old.slice(0, index + 1), snapshot(page)].slice(-100); historyIndex[page] = history[page].length - 1; queueSave(page); }
	function queueSave(page: number) { clearTimeout(saveTimer); saveTimer = setTimeout(() => void save(page), 250); }
	async function save(page: number) { await db.annotations.put({ id: `${score.id}_page_${page}`, scoreId: score.id, pageNum: page, strokes: structuredClone(annotations[page] || []), stamps: structuredClone(stamps[page] || []), notes: structuredClone(notes[page] || []) }); }
	function restore(page: number, state: Snapshot) { annotations[page] = structuredClone(state.strokes); stamps[page] = structuredClone(state.stamps); notes[page] = structuredClone(state.notes); void save(page); redraw(page, canvasForPage(page)); }
	function undo() { const i = historyIndex[current] ?? 0; if (i > 0) { historyIndex[current] = i - 1; restore(current, history[current][i - 1]); } }
	function redo() { const i = historyIndex[current] ?? 0; if (i < (history[current]?.length || 1) - 1) { historyIndex[current] = i + 1; restore(current, history[current][i + 1]); } }
	function chooseTool(t: Tool) { tool = t; annotationOpen = true; if (t !== 'symbol') selectedSymbol = null; }
	function placeSymbol(s: MusicSymbol, p: Point, page: number, canvas: HTMLCanvasElement) { (stamps[page] ||= []).push({ id: crypto.randomUUID(), x: p.x, y: p.y, symbol: s.glyph, label: s.name, color, fontSize: 36 }); checkpoint(page); redraw(page, canvas); selectedSymbol = null; tool = 'move'; }
	function selectSymbol(s: MusicSymbol) { selectedSymbol = s; symbolsOpen = false; annotationOpen = true; tool = 'symbol'; }
	function next() { const step = dual ? 2 : 1, n = current + step; if (pdfDoc && n <= pdfDoc.numPages) { current = n; pageInput = String(n); void render(); } }
	function previous() { const step = dual ? 2 : 1, n = Math.max(1, current - step); if (n !== current) { current = n; pageInput = String(n); void render(); } }
	function gotoPage() { const n = Math.max(1, Math.min(pdfDoc?.numPages || 1, Number(pageInput) || 1)); current = n; pageInput = String(n); void render(); }
	function setZoom(v: number) { zoom = Math.max(.5, Math.min(2.5, v)); fit = 'free'; void render(); }
	function resetView() { zoom = 1; fit = 'page'; void render(); }
	function toggleBookmark() { bookmarked = !bookmarked; localStorage.setItem(`sonora-viewer-v2-${score.id}`, JSON.stringify({ bookmarked, dual, zoom, annotationsVisible })); }
	function persist() { localStorage.setItem(`sonora-viewer-v2-${score.id}`, JSON.stringify({ bookmarked, dual, zoom, annotationsVisible })); settingsOpen = false; }

	function playClick() { if (!audio) audio = new AudioContext(); const now = audio.currentTime; const osc = audio.createOscillator(), gain = audio.createGain(); osc.frequency.value = metroBeat === 0 ? 1100 : 750; gain.gain.setValueAtTime(.0001, now); gain.gain.exponentialRampToValueAtTime(.12, now + .005); gain.gain.exponentialRampToValueAtTime(.0001, now + .045); osc.connect(gain).connect(audio.destination); osc.start(now); osc.stop(now + .05); }
	function startMetronome() { if (metroRunning) return; metroRunning = true; metroBeat = 0; playClick(); metroTimer = setInterval(() => { metroBeat = (metroBeat + 1) % 4; playClick(); }, 60000 / metroBpm); }
	function stopMetronome() { metroRunning = false; if (metroTimer) clearInterval(metroTimer); metroTimer = undefined; }
	function changeBpm(v: number) { metroBpm = Math.max(30, Math.min(240, v)); if (metroRunning) { stopMetronome(); startMetronome(); } }

	async function startTuner() { tunerError = ''; try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false } }); audio ||= new AudioContext(); const source = audio.createMediaStreamSource(stream); analyser = audio.createAnalyser(); analyser.fftSize = 4096; source.connect(analyser); tunerRunning = true; readTuner(); } catch { tunerError = 'Microphone access was denied or is unavailable.'; } }
	function stopTuner() { tunerRunning = false; if (tunerFrame) cancelAnimationFrame(tunerFrame); tunerFrame = 0; stream?.getTracks().forEach(t => t.stop()); stream = null; analyser = null; }
	function readTuner() { if (!tunerRunning || !analyser) return; const data = new Float32Array(analyser.fftSize); analyser.getFloatTimeDomainData(data); let rms = 0; for (const x of data) rms += x * x; rms = Math.sqrt(rms / data.length); if (rms > .01) { let crossings = 0; for (let i = 1; i < data.length; i++) if (data[i - 1] <= 0 && data[i] > 0) crossings++; const hz = crossings * audioSampleRate() / data.length; if (hz > 50 && hz < 1400) { const midi = 69 + 12 * Math.log2(hz / 440); const rounded = Math.round(midi); tunerHz = hz; tunerNote = midiName(rounded); tunerCents = Math.round((midi - rounded) * 100); } } tunerFrame = requestAnimationFrame(readTuner); }
	function audioSampleRate() { return audio?.sampleRate || 44100; }
	function midiName(m: number) { return ['C','C♯','D','D♯','E','F','F♯','G','G♯','A','A♯','B'][((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); }
</script>

<svelte:window onpointerup={endDraw} onpointercancel={endDraw} />

<div class="viewer" bind:this={host}>
	<header class:hide={reading || !controls} class="topbar">
		<button class="icon" aria-label="Back" onclick={onClose}><ArrowLeft size={20}/></button>
		<div class="title"><strong>{score.title}</strong><span>{score.composer}</span></div>
		<div class="top-actions">
			<button class="icon" class:active={bookmarked} onclick={toggleBookmark} aria-label="Bookmark">{#if bookmarked}<BookmarkCheck size={19}/>{:else}<Bookmark size={19}/>{/if}</button>
			<button class="icon" class:active={thumbnails} onclick={()=>thumbnails=!thumbnails} aria-label="Page thumbnails"><Grid3X3 size={19}/></button>
			<button class="icon" onclick={()=>searchOpen=!searchOpen} aria-label="Search"><Search size={19}/></button>
			<button class="icon" onclick={()=>settingsOpen=!settingsOpen} aria-label="Settings"><Settings2 size={19}/></button>
		</div>
	</header>

	{#if searchOpen && !reading}<div class="searchbar"><Search size={17}/><input bind:value={searchText} placeholder="Search this score…"/><span>PDF text search</span></div>{/if}

	<div class="workspace">
		{#if thumbnails && !reading}<aside class="thumbs"><div class="thumb-title">Pages</div>{#each Array(pdfDoc?.numPages || 0) as _, i}<button class:current={i+1===current} onclick={()=>{current=i+1;pageInput=String(current);void render();}}><div class="thumb-number">{i+1}</div></button>{/each}</aside>{/if}
		<div class="score-area">
			{#if busy}<div class="loading"><div class="spinner"></div><span>Rendering score…</span></div>{/if}
			{#if error}<div class="error"><strong>Rendering failed</strong><span>{error}</span><button onclick={()=>void render()}>Try again</button></div>{/if}
			<div class="pages" class:dual class:reading>
				<div class="page-wrap"><canvas bind:this={leftPdf}></canvas><canvas bind:this={leftInk} class="ink" onpointerdown={(e)=>startDraw(e, pageNumbers[0], leftInk!)} onpointermove={moveDraw}></canvas></div>
				{#if dual && pageNumbers[1] <= (pdfDoc?.numPages || 0)}<div class="page-wrap"><canvas bind:this={rightPdf}></canvas><canvas bind:this={rightInk} class="ink" onpointerdown={(e)=>startDraw(e, pageNumbers[1], rightInk!)} onpointermove={moveDraw}></canvas></div>{/if}
			</div>
		</div>
	</div>

	{#if !reading && controls}<footer class="controls">
		<div class="page-controls"><button class="round" onclick={previous}><ChevronLeft size={21}/></button><input bind:value={pageInput} onkeydown={(e)=>e.key==='Enter'&&gotoPage()} onblur={gotoPage}/><span>/ {pdfDoc?.numPages || '—'}</span><button class="round" onclick={next}><ChevronRight size={21}/></button></div>
		<div class="tool-strip">
			<button class:active={annotationOpen&&tool==='pen'} onclick={()=>chooseTool('pen')} title="Pen"><PenTool size={19}/></button>
			<button class:active={annotationOpen&&tool==='highlighter'} onclick={()=>chooseTool('highlighter')} title="Highlighter"><Highlighter size={19}/></button>
			<button class:active={annotationOpen&&tool==='line'} onclick={()=>chooseTool('line')} title="Line"><Minus size={19}/></button>
			<button class:active={annotationOpen&&tool==='arrow'} onclick={()=>chooseTool('arrow')} title="Arrow"><ArrowUpRight size={19}/></button>
			<button class:active={annotationOpen&&tool==='eraser'} onclick={()=>chooseTool('eraser')} title="Eraser"><Eraser size={19}/></button>
			<button class:active={annotationOpen&&tool==='text'} onclick={()=>chooseTool('text')} title="Text"><Type size={19}/></button>
			<button class:active={symbolsOpen} onclick={()=>symbolsOpen=!symbolsOpen} title="Musical symbols"><MusicSymbolIcon/></button>
			<span class="divider"></span>
			<button onclick={undo} disabled={currentHistoryIndex<=0} title="Undo"><Undo2 size={19}/></button>
			<button onclick={redo} disabled={currentHistoryIndex>=currentHistory.length-1} title="Redo"><Redo2 size={19}/></button>
		</div>
		<div class="view-controls"><button onclick={()=>setZoom(zoom-.1)}><ZoomOut size={18}/></button><span>{Math.round(zoom*100)}%</span><button onclick={()=>setZoom(zoom+.1)}><ZoomIn size={18}/></button><button class:active={dual} onclick={()=>{dual=!dual;void render();}} title="Two pages"><BookOpenIcon/></button><button class:active={reading} onclick={()=>reading=true} title="Reading mode"><Maximize2 size={18}/></button></div>
	</footer>{/if}

	{#if annotationOpen && !reading}<div class="annotation-bar"><div class="colors">{#each colors as c}<button class:selected={color===c} style={`--c:${c}`} onclick={()=>color=c}></button>{/each}</div><label>Size <input type="range" min="1" max="12" step="1" bind:value={width}/></label><button class="icon" class:active={!annotationsVisible} onclick={()=>{annotationsVisible=!annotationsVisible;void render();}}>{#if annotationsVisible}<Eye size={18}/>{:else}<EyeOff size={18}/>{/if}</button></div>{/if}

	{#if symbolsOpen}<div class="popover symbols"><div class="popover-head"><strong>Musical symbols</strong><button class="icon" onclick={()=>symbolsOpen=false}><X size={17}/></button></div><div class="symbol-tabs">{#each MUSIC_SYMBOL_CATEGORIES as category}<button class:active={symbolCategory===category} onclick={()=>symbolCategory=category}>{category}</button>{/each}</div><div class="symbol-grid">{#each currentSymbols as s}<button title={s.name} onclick={()=>selectSymbol(s)}><span>{s.glyph}</span><small>{s.name}</small></button>{/each}</div><p>Choose a symbol, then tap the score to place it.</p></div>{/if}

	{#if settingsOpen}<div class="popover settings"><div class="popover-head"><div><strong>Viewer settings</strong><small>Customize your score workspace</small></div><button class="icon" onclick={()=>settingsOpen=false}><X size={17}/></button></div><label class="setting"><span>Show annotations</span><input type="checkbox" bind:checked={annotationsVisible}/></label><label class="setting"><span>Two-page view</span><input type="checkbox" bind:checked={dual}/></label><label class="setting"><span>Reading mode</span><button onclick={()=>{reading=true;settingsOpen=false}}>Enter</button></label><div class="fit-row"><button class:active={fit==='page'} onclick={()=>{fit='page';void render();}}>Fit page</button><button class:active={fit==='width'} onclick={()=>{fit='width';void render();}}>Fit width</button><button class:active={fit==='height'} onclick={()=>{fit='height';void render();}}>Fit height</button><button onclick={resetView}>Reset</button></div><button class="save" onclick={persist}>Save preferences</button></div>{/if}

	{#if utility==='metronome'}<div class="popover utility"><div class="popover-head"><strong>Metronome</strong><button class="icon" onclick={()=>utility='none'}><X size={17}/></button></div><div class="bpm">{metroBpm}<small>BPM</small></div><input type="range" min="30" max="240" bind:value={metroBpm} oninput={(e)=>changeBpm(Number((e.currentTarget as HTMLInputElement).value))}/><div class="beats">{#each [0,1,2,3] as b}<span class:beat={metroBeat===b&&metroRunning}></span>{/each}</div><button class="save" onclick={()=>metroRunning?stopMetronome():startMetronome()}>{#if metroRunning}<Pause size={17}/> Stop{:else}<Play size={17}/> Start{/if}</button></div>{/if}

	{#if utility==='tuner'}<div class="popover utility tuner"><div class="popover-head"><strong>Tuner</strong><button class="icon" onclick={stopTuner}><X size={17}/></button></div><div class="tuner-note">{tunerNote}</div><div class="meter"><div style={`left:${50 + Math.max(-50,Math.min(50,tunerCents))/2}%`}></div></div><div class="cents">{tunerCents > 0 ? '+' : ''}{tunerCents} cents · {tunerHz ? tunerHz.toFixed(1) : '—'} Hz</div>{#if tunerError}<p class="error-text">{tunerError}</p>{/if}{#if !tunerRunning}<button class="save" onclick={startTuner}><Mic2 size={17}/> Enable microphone</button>{:else}<button class="save" onclick={stopTuner}>Stop tuner</button>{/if}</div>{/if}

	{#if !reading && controls}<div class="utility-dock"><button class:active={utility==='metronome'} onclick={()=>utility=utility==='metronome'?'none':'metronome'}><Timer size={18}/><span>Metronome</span></button><button class:active={utility==='tuner'} onclick={()=>utility=utility==='tuner'?'none':'tuner'}><Mic2 size={18}/><span>Tuner</span></button></div>{/if}
	{#if reading}<button class="exit-reading" onclick={()=>reading=false}><MinimizeIcon/> Exit reading mode</button>{/if}
</div>

{#snippet MusicSymbolIcon()}<span class="music-icon">♬</span>{/snippet}
{#snippet BookOpenIcon()}<span class="music-icon">Ⅱ</span>{/snippet}
{#snippet MinimizeIcon()}<span class="music-icon">↙</span>{/snippet}

<style>
	@font-face{font-family:LelandText;src:url('/fonts/LelandText.woff2') format('woff2');font-display:swap}
	:global(html),:global(body){margin:0;height:100%;overflow:hidden}
	.viewer{height:100%;width:100%;background:#11110f;color:#f5f5f4;display:flex;flex-direction:column;position:relative;overflow:hidden;font-family:ui-sans-serif,system-ui,sans-serif}
	.topbar{height:64px;min-height:64px;display:flex;align-items:center;gap:12px;padding:0 14px;border-bottom:1px solid #ffffff12;background:#171714ee;backdrop-filter:blur(18px);z-index:10;transition:opacity .2s,transform .2s}.topbar.hide{opacity:0;transform:translateY(-100%);pointer-events:none}.title{display:flex;flex-direction:column;min-width:0;flex:1}.title strong{font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.title span{font-size:11px;color:#85857f;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.top-actions{display:flex;gap:4px}.icon,.tool-strip button,.view-controls button,.round{border:0;background:transparent;color:#a8a8a1;display:grid;place-items:center;border-radius:12px;min-width:42px;height:42px;cursor:pointer;transition:background .15s,color .15s,transform .15s}.icon:hover,.tool-strip button:hover,.view-controls button:hover,.round:hover{background:#ffffff0d;color:#fff}.icon.active,.tool-strip button.active,.view-controls button.active{background:#6d4aff25;color:#b9a8ff}.icon:active,.tool-strip button:active,.view-controls button:active{transform:scale(.95)}button:disabled{opacity:.25;cursor:default}.workspace{flex:1;min-height:0;display:flex;overflow:hidden}.thumbs{width:92px;overflow:auto;padding:12px 9px;border-right:1px solid #ffffff0c;background:#141411}.thumb-title{text-align:center;font-size:10px;color:#77776f;text-transform:uppercase;letter-spacing:.12em;margin-bottom:10px}.thumbs button{width:72px;margin-bottom:9px;padding:4px;background:#1b1b18;border:1px solid #ffffff10;border-radius:8px;cursor:pointer}.thumbs button.current{border-color:#8064ff;background:#6d4aff20}.thumb-number{font-size:10px;color:#888;text-align:center;margin:2px}.score-area{flex:1;min-width:0;min-height:0;overflow:auto;position:relative;background:#24231f;scrollbar-gutter:stable}.pages{min-height:100%;width:max-content;min-width:100%;display:flex;align-items:flex-start;justify-content:center;gap:32px;padding:32px}.pages.dual{gap:24px}.page-wrap{position:relative;flex:none;background:#fff;box-shadow:0 12px 35px #0008;border-radius:2px;overflow:hidden;touch-action:none}.page-wrap canvas{display:block}.page-wrap .ink{position:absolute;inset:0;z-index:2}.loading{position:absolute;top:14px;left:50%;transform:translateX(-50%);z-index:5;display:flex;gap:9px;align-items:center;padding:9px 14px;border-radius:999px;background:#151513e8;border:1px solid #ffffff12;font-size:12px;color:#aaa;backdrop-filter:blur(10px)}.spinner{width:13px;height:13px;border:2px solid #ffffff22;border-top-color:#a78bfa;border-radius:50%;animation:spin .7s linear infinite}@keyframes spin{to{transform:rotate(360deg)}}.error{position:absolute;z-index:6;left:50%;top:50%;transform:translate(-50%,-50%);width:min(420px,calc(100% - 32px));padding:24px;border:1px solid #ffffff12;border-radius:20px;background:#171714f5;box-shadow:0 20px 50px #0009;display:flex;flex-direction:column;gap:8px;text-align:center}.error span{font-size:12px;color:#888}.error button,.save{border:0;background:#6d4aff;color:white;padding:11px 15px;border-radius:12px;font-weight:600;display:flex;align-items:center;justify-content:center;gap:7px;cursor:pointer;margin-top:8px}.controls{min-height:68px;padding:8px 12px;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:12px;border-top:1px solid #ffffff0c;background:#171714f2;backdrop-filter:blur(18px);z-index:10}.page-controls,.view-controls,.tool-strip{display:flex;align-items:center;gap:4px}.page-controls input{width:42px;height:38px;border:1px solid #ffffff12;background:#0e0e0c;color:#fff;border-radius:10px;text-align:center;outline:none}.page-controls span,.view-controls span{font-size:11px;color:#777}.tool-strip{justify-content:center}.divider{width:1px;height:25px;background:#ffffff12;margin:0 4px}.view-controls{justify-content:flex-end}.view-controls button{min-width:38px;height:38px}.annotation-bar{position:absolute;bottom:80px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;padding:8px 12px;border:1px solid #ffffff12;background:#181815ee;border-radius:16px;box-shadow:0 14px 35px #0007;z-index:12;backdrop-filter:blur(16px)}.colors{display:flex;gap:5px}.colors button{width:23px;height:23px;border-radius:50%;border:2px solid transparent;background:var(--c);cursor:pointer}.colors button.selected{border-color:#fff;box-shadow:0 0 0 2px #ffffff33}.annotation-bar label{font-size:11px;color:#888;display:flex;align-items:center;gap:6px}.annotation-bar input{width:85px}.popover{position:absolute;right:14px;top:74px;width:min(390px,calc(100vw - 28px));padding:14px;border:1px solid #ffffff12;background:#1a1a17f7;border-radius:18px;box-shadow:0 20px 60px #0009;backdrop-filter:blur(22px);z-index:30}.popover-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.popover-head strong{font-size:14px}.popover-head small{display:block;color:#777;font-size:10px;margin-top:3px}.symbol-tabs{display:flex;gap:5px;overflow:auto;padding:12px 0 8px}.symbol-tabs button{white-space:nowrap;border:0;background:#ffffff06;color:#888;border-radius:9px;padding:7px 9px;font-size:10px;cursor:pointer}.symbol-tabs button.active{background:#6d4aff25;color:#c4b5fd}.symbol-grid{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;max-height:320px;overflow:auto}.symbol-grid button{min-height:68px;border:1px solid #ffffff09;background:#ffffff04;border-radius:10px;color:#eee;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px}.symbol-grid button:hover{background:#ffffff0c;border-color:#6d4aff66}.symbol-grid span{font-family:LelandText,Leland,Bravura,serif;font-size:30px}.symbol-grid small{font-size:8px;color:#777;text-align:center}.symbols p{font-size:10px;color:#777;margin:10px 2px 2px}.settings{width:300px}.setting{display:flex;justify-content:space-between;align-items:center;padding:13px 2px;border-bottom:1px solid #ffffff09;font-size:12px;color:#bbb}.setting button{border:0;background:#ffffff0a;color:#ccc;padding:7px 10px;border-radius:8px;cursor:pointer}.fit-row{display:grid;grid-template-columns:repeat(4,1fr);gap:5px;margin-top:12px}.fit-row button{border:1px solid #ffffff0a;background:#ffffff05;color:#999;border-radius:9px;padding:8px 3px;font-size:9px;cursor:pointer}.fit-row button.active{background:#6d4aff22;color:#c4b5fd}.utility{width:260px}.bpm{text-align:center;font-size:48px;font-weight:700;margin:12px}.bpm small{font-size:10px;color:#777;margin-left:5px}.beats{display:flex;justify-content:center;gap:8px;margin:12px}.beats span{width:9px;height:9px;border-radius:50%;background:#ffffff1c}.beats span.beat{background:#a78bfa;box-shadow:0 0 12px #a78bfa}.tuner-note{text-align:center;font-size:54px;font-weight:700;margin:10px}.meter{height:6px;border-radius:999px;background:#ffffff12;position:relative;margin:18px 8px}.meter div{position:absolute;top:-6px;width:2px;height:18px;background:#a78bfa;transition:left .08s}.cents{text-align:center;font-size:11px;color:#888}.error-text{font-size:11px;color:#f87171}.utility input[type=range]{width:100%}.utility .save{width:100%}.utility-dock{position:absolute;right:14px;bottom:82px;display:flex;gap:5px;z-index:11}.utility-dock button{border:1px solid #ffffff0e;background:#181815ee;color:#aaa;border-radius:13px;padding:9px 11px;display:flex;align-items:center;gap:7px;font-size:10px;cursor:pointer;backdrop-filter:blur(12px)}.utility-dock button.active{color:#c4b5fd;background:#6d4aff22}.searchbar{position:absolute;top:72px;left:50%;transform:translateX(-50%);z-index:20;width:min(520px,calc(100vw - 28px));height:42px;border:1px solid #ffffff12;border-radius:13px;background:#181815f5;display:flex;align-items:center;gap:8px;padding:0 12px;box-shadow:0 12px 35px #0008}.searchbar input{flex:1;background:transparent;border:0;outline:0;color:#fff;font-size:12px}.searchbar span{font-size:9px;color:#666}.exit-reading{position:absolute;top:14px;right:14px;z-index:40;border:1px solid #ffffff12;background:#181815dd;color:#aaa;border-radius:12px;padding:9px 12px;font-size:10px;display:flex;align-items:center;gap:7px;cursor:pointer}.music-icon{font-family:LelandText,Leland,serif;font-size:20px}@media(max-width:800px){.topbar{height:58px;min-height:58px;padding:0 8px}.controls{grid-template-columns:1fr auto;min-height:64px}.tool-strip{order:3;grid-column:1/-1;justify-content:flex-start;overflow-x:auto;padding:2px 0}.view-controls{display:none}.page-controls{justify-content:flex-end}.pages{padding:18px 10px;gap:12px}.thumbs{width:72px}.thumbs button{width:56px}.annotation-bar{bottom:130px;max-width:calc(100% - 20px);overflow-x:auto}.utility-dock{bottom:132px}.title strong{max-width:190px}.symbol-grid{grid-template-columns:repeat(4,1fr)}}@media(max-width:520px){.title span{display:none}.top-actions .icon{min-width:38px}.page-controls{justify-content:center}.controls{padding:6px 7px}.utility-dock button span{display:none}.annotation-bar{left:8px;right:8px;transform:none}.settings,.symbols,.utility{right:8px;top:66px}.symbol-grid{grid-template-columns:repeat(3,1fr)}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001ms!important;transition-duration:.001ms!important}}
</style>
