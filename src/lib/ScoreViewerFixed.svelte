<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as pdfjsLib from 'pdfjs-dist';
	import { db } from './db';
	import type { ScoreItem, Stroke, Point, SymbolStamp, TextNote } from './types';
	import { MUSIC_SYMBOLS, MUSIC_SYMBOL_CATEGORIES } from './musicSymbols';
	import {
		ArrowLeft, ArrowUpRight, Bookmark, BookmarkCheck, ChevronLeft, ChevronRight,
		Columns2, Download, Eraser, Eye, EyeOff, Highlighter, Maximize2, Minimize2,
		Minus, MousePointer2, Music2, PenTool, Printer, Redo2, Search, Square,
		Type, Undo2, X, ZoomIn, ZoomOut
	} from 'lucide-svelte';

	let { score, onClose }: { score: ScoreItem; onClose: () => void } = $props();
	type Tool = 'move' | 'pen' | 'highlighter' | 'eraser' | 'line' | 'arrow' | 'symbol' | 'text';
	type Fit = 'page' | 'width';
	type Snapshot = { strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[] };

	class BlobRangeTransport extends pdfjsLib.PDFDataRangeTransport {
		private blob: Blob;
		private pending = new Map<string, Promise<void>>();
		private stopped = false;
		constructor(blob: Blob) {
			super(blob.size, null, false, 'score.pdf');
			this.blob = blob;
		}
		requestDataRange(begin: number, end: number) {
			if (this.stopped) return;
			const key = `${begin}:${end}`;
			if (this.pending.has(key)) return;
			const request = this.blob.slice(begin, end).arrayBuffer().then((buffer) => {
				if (this.stopped) return;
				this.onDataRange(begin, new Uint8Array(buffer));
				this.onDataProgress(Math.min(end, this.blob.size));
			});
			this.pending.set(key, request);
			request.catch((error) => this.onError(error)).finally(() => this.pending.delete(key));
		}
		abort() {
			this.stopped = true;
			this.pending.clear();
		}
	}

	let pdf = $state<pdfjsLib.PDFDocumentProxy | null>(null);
	let transport: BlobRangeTransport | null = null;
	let page = $state(1);
	let pageInput = $state('1');
	let zoom = $state(1);
	let fit = $state<Fit>('page');
	let dual = $state(false);
	let loading = $state(false);
	let error = $state('');
	let controls = $state(true);
	let reading = $state(false);
	let searchOpen = $state(false);
	let searchText = $state('');
	let searchStatus = $state('');
	let settingsOpen = $state(false);
	let bookmarked = $state(false);
	let annotationsVisible = $state(true);
	let tool = $state<Tool>('move');
	let color = $state('#c2410c');
	let width = $state(3);
	let selectedSymbol = $state(MUSIC_SYMBOLS[0]);
	let symbolCategory = $state<(typeof MUSIC_SYMBOL_CATEGORIES)[number]>('Clefs');
	let symbolSearch = $state('');
	let symbolSize = $state(34);
	let textSize = $state(18);

	let strokes = $state<Record<number, Stroke[]>>({});
	let stamps = $state<Record<number, SymbolStamp[]>>({});
	let notes = $state<Record<number, TextNote[]>>({});
	let histories = $state<Record<number, Snapshot[]>>({});
	let historyIndex = $state<Record<number, number>>({});
	let host = $state<HTMLElement | null>(null);
	let leftPdf = $state<HTMLCanvasElement | null>(null);
	let rightPdf = $state<HTMLCanvasElement | null>(null);
	let leftInk = $state<HTMLCanvasElement | null>(null);
	let rightInk = $state<HTMLCanvasElement | null>(null);
	let generation = 0;
	let tasks: pdfjsLib.RenderTask[] = [];
	let resizeTimer: ReturnType<typeof setTimeout> | undefined;
	let saveTimers = new Map<number, ReturnType<typeof setTimeout>>();
	let drawing: { page: number; canvas: HTMLCanvasElement; pointerId: number; stroke?: Stroke; raf?: number } | null = null;

	const prefs = `sonora-viewer-${score.id}`;
	const maxPixels = 6000000;
	const colors = ['#c2410c', '#2563eb', '#15803d', '#a16207', '#7e22ce', '#111827', '#ffffff'];
	const pages = $derived(pdf ? (dual ? [Math.max(1, page % 2 === 0 ? page : page - 1), Math.min(pdf.numPages, (page % 2 === 0 ? page : page - 1) + 1)] : [page]) : [page]);
	const filteredSymbols = $derived(MUSIC_SYMBOLS.filter((s) => s.category === symbolCategory && (!symbolSearch.trim() || s.name.toLowerCase().includes(symbolSearch.toLowerCase()))));
	const canUndo = $derived((historyIndex[page] ?? 0) > 0);
	const canRedo = $derived((historyIndex[page] ?? 0) < (histories[page]?.length ?? 1) - 1);

	onMount(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(prefs) || '{}');
			bookmarked = !!saved.bookmarked;
			dual = !!saved.dual;
			zoom = typeof saved.zoom === 'number' ? saved.zoom : 1;
			fit = saved.fit === 'width' ? 'width' : 'page';
			annotationsVisible = saved.annotationsVisible !== false;
		} catch {}
		void load();
		const key = (event: KeyboardEvent) => {
			if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) return;
			if (event.key === 'ArrowRight') next();
			else if (event.key === 'ArrowLeft') previous();
			else if (event.key === '+' || event.key === '=') setZoom(zoom + 0.1);
			else if (event.key === '-') setZoom(zoom - 0.1);
			else if (event.key.toLowerCase() === 'p') choose('pen');
			else if (event.key.toLowerCase() === 'h') choose('highlighter');
			else if (event.key.toLowerCase() === 'e') choose('eraser');
			else if (event.key.toLowerCase() === 's') choose('symbol');
			else if (event.key.toLowerCase() === 't') choose('text');
			else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') { event.preventDefault(); undo(); }
			else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') { event.preventDefault(); redo(); }
			else if (event.key === 'Escape') { settingsOpen = false; searchOpen = false; choose('move'); }
		};
		window.addEventListener('keydown', key);
		const observer = new ResizeObserver(() => {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => void render(), 140);
		});
		if (host) observer.observe(host);
		return () => {
			window.removeEventListener('keydown', key);
			observer.disconnect();
			clearTimeout(resizeTimer);
			cancelRender();
			for (const timer of saveTimers.values()) clearTimeout(timer);
			transport?.abort();
			void pdf?.destroy();
		};
	});

	async function load() {
		loading = true;
		error = '';
		try {
			transport = new BlobRangeTransport(score.pdfBlob);
			pdf = await pdfjsLib.getDocument({
				range: transport,
				rangeChunkSize: 1024 * 1024,
				disableStream: true,
				disableAutoFetch: false,
				isEvalSupported: false,
				useWorkerFetch: false
			}).promise;
			const records = await db.annotations.where('scoreId').equals(score.id).toArray();
			for (const record of records) {
				strokes[record.pageNum] = record.strokes || [];
				stamps[record.pageNum] = record.stamps || [];
				notes[record.pageNum] = record.notes || [];
				const initial = { strokes: structuredClone(record.strokes || []), stamps: structuredClone(record.stamps || []), notes: structuredClone(record.notes || []) };
				histories[record.pageNum] = [initial];
				historyIndex[record.pageNum] = 0;
			}
			await tick();
			ensureHistory(page);
			await render();
		} catch (reason) {
			console.error('PDF load failed', reason);
			error = 'Sonora could not open this score. The PDF may be damaged or unsupported.';
		} finally {
			loading = false;
		}
	}

	function cancelRender() {
		for (const task of tasks) { try { task.cancel(); } catch {} }
		tasks = [];
	}

	async function render() {
		if (!pdf || !host) return;
		cancelRender();
		const current = ++generation;
		loading = true;
		error = '';
		try {
			if (dual && host.clientWidth < 800) dual = false;
			for (let i = 0; i < pages.length; i++) {
				await renderPage(pages[i], i, current);
				if (current !== generation) return;
			}
		} catch (reason) {
			if (!(reason instanceof Error && reason.name === 'RenderingCancelledException') && current === generation) {
				console.error('PDF render failed', reason);
				error = 'This page could not be rendered. Try Fit Page or reduce the zoom.';
			}
		} finally {
			if (current === generation) loading = false;
		}
	}

	async function renderPage(number: number, index: number, current: number) {
		if (!pdf || !host) return;
		const pdfPage = await pdf.getPage(number);
		if (current !== generation) { try { pdfPage.cleanup(); } catch {} return; }
		const base = pdfPage.getViewport({ scale: 1 });
		const availableWidth = Math.max(280, dual ? (host.clientWidth - 100) / 2 : host.clientWidth - 64);
		const availableHeight = Math.max(280, host.clientHeight - 76);
		let scale = (fit === 'width' ? availableWidth / base.width : Math.min(availableWidth / base.width, availableHeight / base.height)) * zoom;
		const pixelLimitScale = Math.sqrt(maxPixels / Math.max(1, base.width * base.height));
		scale = Math.max(0.2, Math.min(3, scale, pixelLimitScale));
		const viewport = pdfPage.getViewport({ scale });
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		const widthPx = Math.ceil(viewport.width);
		const heightPx = Math.ceil(viewport.height);
		const pdfCanvas = index === 0 ? leftPdf : rightPdf;
		const inkCanvas = index === 0 ? leftInk : rightInk;
		if (!pdfCanvas || !inkCanvas) { try { pdfPage.cleanup(); } catch {} return; }
		for (const canvas of [pdfCanvas, inkCanvas]) {
			canvas.width = Math.ceil(widthPx * dpr);
			canvas.height = Math.ceil(heightPx * dpr);
			canvas.style.width = `${widthPx}px`;
			canvas.style.height = `${heightPx}px`;
		}
		const context = pdfCanvas.getContext('2d', { alpha: false })!;
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.fillStyle = '#fff';
		context.fillRect(0, 0, widthPx, heightPx);
		const task = pdfPage.render({ canvasContext: context, viewport });
		tasks.push(task);
		await task.promise;
		if (current === generation) redraw(number, inkCanvas);
		try { pdfPage.cleanup(); } catch {}
	}

	function position(event: PointerEvent, canvas: HTMLCanvasElement): Point {
		const rect = canvas.getBoundingClientRect();
		return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)), pressure: event.pressure || 0.5 };
	}
	function pointToCanvas(point: Point, canvas: HTMLCanvasElement) {
		const rect = canvas.getBoundingClientRect();
		return { x: point.x * rect.width, y: point.y * rect.height };
	}
	function choose(nextTool: Tool) { tool = nextTool; }

	function begin(event: PointerEvent, number: number, canvas: HTMLCanvasElement) {
		if (tool === 'move' || reading) return;
		event.preventDefault();
		canvas.setPointerCapture(event.pointerId);
		const point = position(event, canvas);
		if (tool === 'symbol') {
			stamps[number] = [...(stamps[number] || []), { id: crypto.randomUUID(), symbol: selectedSymbol.glyph, label: selectedSymbol.name, x: point.x, y: point.y, fontSize: symbolSize, color }];
			ensureHistory(number); checkpoint(number); redraw(number, canvas); return;
		}
		if (tool === 'text') {
			const text = window.prompt('Text annotation');
			if (text?.trim()) {
				notes[number] = [...(notes[number] || []), { id: crypto.randomUUID(), text: text.trim(), x: point.x, y: point.y, fontSize: textSize, color }];
				ensureHistory(number); checkpoint(number); redraw(number, canvas);
			}
			return;
		}
		if (tool === 'eraser') {
			drawing = { page: number, canvas, pointerId: event.pointerId };
			erase(point, number, canvas, false); return;
		}
		const stroke: Stroke = { id: crypto.randomUUID(), tool: tool === 'highlighter' ? 'highlighter' : 'pen', kind: tool === 'line' ? 'line' : tool === 'arrow' ? 'arrow' : 'freehand', color, width, points: [point] };
		ensureHistory(number);
		strokes[number] = [...(strokes[number] || []), stroke];
		drawing = { page: number, canvas, pointerId: event.pointerId, stroke };
		redraw(number, canvas);
	}

	function move(event: PointerEvent) {
		if (!drawing) return;
		for (const pointEvent of event.getCoalescedEvents?.() || [event]) {
			if (drawing.stroke) {
				const stroke = (strokes[drawing.page] || []).find((item) => item.id === drawing?.stroke?.id);
				if (stroke) {
					const point = position(pointEvent, drawing.canvas);
					if (stroke.kind === 'line' || stroke.kind === 'arrow') stroke.points = [stroke.points[0], point];
					else stroke.points.push(point);
				}
			} else erase(position(pointEvent, drawing.canvas), drawing.page, drawing.canvas, false);
		}
		if (!drawing.raf) drawing.raf = requestAnimationFrame(() => { if (drawing) redraw(drawing.page, drawing.canvas); if (drawing) drawing.raf = undefined; });
	}
	function end() {
		if (!drawing) return;
		const active = drawing;
		if (active.raf) cancelAnimationFrame(active.raf);
		drawing = null;
		try { active.canvas.releasePointerCapture(active.pointerId); } catch {}
		redraw(active.page, active.canvas);
		checkpoint(active.page);
	}
	function erase(point: Point, number: number, canvas: HTMLCanvasElement | null, save = true) {
		const radius = Math.max(0.006, width / 850);
		const before = strokes[number] || [];
		const after = before.filter((stroke) => !stroke.points.some((candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) < radius));
		if (after.length !== before.length) { strokes[number] = after; if (canvas) redraw(number, canvas); if (save) checkpoint(number); }
	}

	function redraw(number: number, canvas: HTMLCanvasElement | null) {
		if (!canvas) return;
		const context = canvas.getContext('2d')!;
		const rect = canvas.getBoundingClientRect();
		const scale = canvas.width / Math.max(1, rect.width);
		context.setTransform(scale, 0, 0, scale, 0, 0);
		context.clearRect(0, 0, rect.width, rect.height);
		if (!annotationsVisible) return;
		for (const stroke of strokes[number] || []) drawStroke(context, stroke, canvas);
		context.save();
		context.textAlign = 'center'; context.textBaseline = 'middle';
		for (const stamp of stamps[number] || []) {
			const point = pointToCanvas({ x: stamp.x, y: stamp.y }, canvas);
			context.font = `${stamp.fontSize}px Leland`; context.fillStyle = stamp.color; context.fillText(stamp.symbol, point.x, point.y);
		}
		context.restore();
		for (const note of notes[number] || []) {
			const point = pointToCanvas({ x: note.x, y: note.y }, canvas);
			context.save(); context.font = `600 ${note.fontSize}px system-ui,sans-serif`; context.fillStyle = note.color; context.textBaseline = 'top'; context.shadowColor = 'rgba(255,255,255,.8)'; context.shadowBlur = 3; context.fillText(note.text, point.x, point.y); context.restore();
		}
	}
	function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, canvas: HTMLCanvasElement) {
		if (!stroke.points.length) return;
		const points = stroke.points.map((point) => pointToCanvas(point, canvas));
		context.save(); context.strokeStyle = stroke.color; context.fillStyle = stroke.color; context.lineWidth = stroke.width; context.lineCap = 'round'; context.lineJoin = 'round';
		if (stroke.tool === 'highlighter') context.globalAlpha = 0.28;
		if (stroke.kind === 'line' || stroke.kind === 'arrow') {
			const start = points[0]; const end = points[points.length - 1];
			context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); context.stroke();
			if (stroke.kind === 'arrow') {
				const angle = Math.atan2(end.y - start.y, end.x - start.x); const size = Math.max(8, stroke.width * 3);
				context.beginPath(); context.moveTo(end.x, end.y); context.lineTo(end.x - size * Math.cos(angle - Math.PI / 6), end.y - size * Math.sin(angle - Math.PI / 6)); context.lineTo(end.x - size * Math.cos(angle + Math.PI / 6), end.y - size * Math.sin(angle + Math.PI / 6)); context.closePath(); context.fill();
			}
		} else {
			context.beginPath(); context.moveTo(points[0].x, points[0].y); for (let i = 1; i < points.length; i++) context.lineTo(points[i].x, points[i].y); context.stroke();
		}
		context.restore();
	}

	function snapshot(number: number): Snapshot { return { strokes: structuredClone(strokes[number] || []), stamps: structuredClone(stamps[number] || []), notes: structuredClone(notes[number] || []) }; }
	function ensureHistory(number: number) { if (!histories[number]) { histories[number] = [snapshot(number)]; historyIndex[number] = 0; } }
	function checkpoint(number: number) {
		ensureHistory(number);
		const list = histories[number]; const index = historyIndex[number] ?? list.length - 1; const nextList = [...list.slice(0, index + 1), snapshot(number)].slice(-80);
		histories[number] = nextList; historyIndex[number] = nextList.length - 1; scheduleSave(number);
	}
	function applySnapshot(number: number, state: Snapshot) { strokes[number] = structuredClone(state.strokes); stamps[number] = structuredClone(state.stamps); notes[number] = structuredClone(state.notes); const canvas = number === pages[0] ? leftInk : rightInk; redraw(number, canvas); scheduleSave(number); }
	function undo() { ensureHistory(page); const index = historyIndex[page] ?? 0; if (index <= 0) return; historyIndex[page] = index - 1; applySnapshot(page, histories[page][index - 1]); }
	function redo() { ensureHistory(page); const index = historyIndex[page] ?? 0; const list = histories[page]; if (index >= list.length - 1) return; historyIndex[page] = index + 1; applySnapshot(page, list[index + 1]); }
	function scheduleSave(number: number) { const old = saveTimers.get(number); if (old) clearTimeout(old); saveTimers.set(number, setTimeout(() => void saveAnnotations(number), 250)); }
	async function saveAnnotations(number: number) { await db.annotations.put({ id: `${score.id}:${number}`, scoreId: score.id, pageNum: number, strokes: $state.snapshot(strokes[number] || []), stamps: $state.snapshot(stamps[number] || []), notes: $state.snapshot(notes[number] || []) }); }

	function persistPrefs() { localStorage.setItem(prefs, JSON.stringify({ bookmarked, dual, zoom, fit, annotationsVisible })); }
	function setZoom(value: number) { zoom = Math.max(0.4, Math.min(2.5, Number(value.toFixed(2)))); persistPrefs(); void render(); }
	function setFit(value: Fit) { fit = value; zoom = 1; persistPrefs(); void render(); }
	function next() { if (!pdf) return; page = Math.min(pdf.numPages, dual ? page + 2 : page + 1); pageInput = String(page); ensureHistory(page); void render(); }
	function previous() { page = Math.max(1, dual ? page - 2 : page - 1); pageInput = String(page); ensureHistory(page); void render(); }
	function goToPage() { const value = Math.max(1, Math.min(pdf?.numPages || 1, Number.parseInt(pageInput, 10) || 1)); page = value; pageInput = String(value); ensureHistory(page); void render(); }
	function toggleBookmark() { bookmarked = !bookmarked; persistPrefs(); }
	function toggleAnnotations() { annotationsVisible = !annotationsVisible; persistPrefs(); void render(); }
	async function searchPdf() {
		if (!pdf || !searchText.trim()) return;
		searchStatus = 'Searching…'; const needle = searchText.trim().toLowerCase();
		for (let number = 1; number <= pdf.numPages; number++) {
			try {
				const pdfPage = await pdf.getPage(number); const content = await pdfPage.getTextContent();
				const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').toLowerCase();
				try { pdfPage.cleanup(); } catch {}
				if (text.includes(needle)) { page = number; pageInput = String(number); searchStatus = `Found on page ${number}`; void render(); return; }
			} catch {}
		}
		searchStatus = 'Not found';
	}
	function downloadScore() { const url = URL.createObjectURL(score.pdfBlob); const link = document.createElement('a'); link.href = url; link.download = `${score.title}.pdf`; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
	function printScore() { window.print(); }
	async function toggleFullScreen() { if (!document.fullscreenElement) await host?.requestFullscreen(); else await document.exitFullscreen(); }
</script>

<svelte:head><title>{score.title} — Sonora</title></svelte:head>

<div class="viewer" bind:this={host} class:reading>
	<header class="topbar" class:hidden={reading || !controls}>
		<div class="topbar-left">
			<button class="icon-button" title="Back to library" aria-label="Back to library" onclick={onClose}><ArrowLeft size={19} /></button>
			<div class="score-title"><strong>{score.title}</strong><span>{score.composer}</span></div>
		</div>
		<div class="page-controls">
			<button class="icon-button" title="Previous page" aria-label="Previous page" onclick={previous} disabled={page <= 1}><ChevronLeft size={19} /></button>
			<input aria-label="Page number" bind:value={pageInput} onkeydown={(e) => e.key === 'Enter' && goToPage()} onblur={goToPage} />
			<span>/ {pdf?.numPages ?? score.totalPages}</span>
			<button class="icon-button" title="Next page" aria-label="Next page" onclick={next} disabled={!pdf || page >= pdf.numPages}><ChevronRight size={19} /></button>
		</div>
		<div class="topbar-right">
			<button class="icon-button" title={bookmarked ? 'Remove bookmark' : 'Bookmark score'} aria-label="Bookmark score" onclick={toggleBookmark}>{#if bookmarked}<BookmarkCheck size={18} />{:else}<Bookmark size={18} />{/if}</button>
			<button class="icon-button" title="Search PDF text" aria-label="Search PDF text" onclick={() => (searchOpen = !searchOpen)}><Search size={18} /></button>
			<button class="icon-button" title="Print" aria-label="Print" onclick={printScore}><Printer size={18} /></button>
			<button class="icon-button" title="Download original PDF" aria-label="Download original PDF" onclick={downloadScore}><Download size={18} /></button>
			<button class="icon-button" title="Reading mode" aria-label="Reading mode" onclick={() => (reading = !reading)}>{#if reading}<EyeOff size={18} />{:else}<Eye size={18} />{/if}</button>
		</div>
	</header>

	{#if searchOpen && !reading}
		<div class="search-panel"><Search size={17} /><input autofocus bind:value={searchText} placeholder="Find text in this score…" onkeydown={(e) => e.key === 'Enter' && searchPdf()} /><button class="text-button" onclick={searchPdf}>Find</button><span>{searchStatus}</span><button class="icon-button" aria-label="Close search" onclick={() => (searchOpen = false)}><X size={17} /></button></div>
	{/if}

	<main class="workspace">
		<div class="pages" class:dual>
			{#if leftPdf && leftInk}{/if}
			<div class="page-shell">
				<canvas class="pdf-canvas" bind:this={leftPdf}></canvas>
				<canvas class="ink-canvas" class:interactive={tool !== 'move' && !reading} bind:this={leftInk} onpointerdown={(event) => begin(event, pages[0], leftInk!)} onpointermove={move} onpointerup={end} onpointercancel={end}></canvas>
			</div>
			{#if dual && pages.length > 1}
				<div class="page-shell">
					<canvas class="pdf-canvas" bind:this={rightPdf}></canvas>
					<canvas class="ink-canvas" class:interactive={tool !== 'move' && !reading} bind:this={rightInk} onpointerdown={(event) => begin(event, pages[1], rightInk!)} onpointermove={move} onpointerup={end} onpointercancel={end}></canvas>
				</div>
			{/if}
		</div>
		{#if loading}<div class="loading"><span></span><span>Loading score…</span></div>{/if}
		{#if error}<div class="error"><strong>Unable to display this page</strong><span>{error}</span></div>{/if}
	</main>

	{#if !reading && controls}
		<aside class="annotation-bar">
			<div class="tool-group">
				<button class:active={tool === 'move'} class="tool-button" title="Move / pan" onclick={() => choose('move')}><MousePointer2 size={18} /><span>Move</span></button>
				<button class:active={tool === 'pen'} class="tool-button" title="Pen (P)" onclick={() => choose('pen')}><PenTool size={18} /><span>Pen</span></button>
				<button class:active={tool === 'highlighter'} class="tool-button" title="Highlighter (H)" onclick={() => choose('highlighter')}><Highlighter size={18} /><span>Highlight</span></button>
				<button class:active={tool === 'line'} class="tool-button" title="Straight line" onclick={() => choose('line')}><Minus size={18} /><span>Line</span></button>
				<button class:active={tool === 'arrow'} class="tool-button" title="Arrow" onclick={() => choose('arrow')}><ArrowUpRight size={18} /><span>Arrow</span></button>
				<button class:active={tool === 'eraser'} class="tool-button" title="Eraser (E)" onclick={() => choose('eraser')}><Eraser size={18} /><span>Erase</span></button>
				<button class:active={tool === 'symbol'} class="tool-button" title="Musical symbol palette (S)" onclick={() => choose('symbol')}><Music2 size={18} /><span>Symbols</span></button>
				<button class:active={tool === 'text'} class="tool-button" title="Text annotation (T)" onclick={() => choose('text')}><Type size={18} /><span>Text</span></button>
			</div>
			<div class="divider"></div>
			<div class="tool-group compact"><button class="icon-button" title="Undo" aria-label="Undo" disabled={!canUndo} onclick={undo}><Undo2 size={18} /></button><button class="icon-button" title="Redo" aria-label="Redo" disabled={!canRedo} onclick={redo}><Redo2 size={18} /></button><div class="color-row">{#each colors as swatch}<button class="swatch" class:selected={color === swatch} style={`--swatch:${swatch}`} title={swatch} onclick={() => (color = swatch)}></button>{/each}</div><label class="range-label">Size <input type="range" min="1" max="14" bind:value={width} /></label></div>
		</aside>
	{/if}

	{#if !reading && tool === 'symbol'}
		<section class="symbol-palette">
			<div class="palette-header"><div><strong>Musical symbols</strong><span>Leland notation font</span></div><input bind:value={symbolSearch} placeholder="Search symbols" /></div>
			<div class="category-row">{#each MUSIC_SYMBOL_CATEGORIES as category}<button class:active={symbolCategory === category} onclick={() => (symbolCategory = category)}>{category}</button>{/each}</div>
			<div class="symbol-grid">{#each filteredSymbols as symbol}<button class:selected={selectedSymbol.id === symbol.id} class="symbol-button" title={symbol.name} onclick={() => (selectedSymbol = symbol)}><span>{symbol.glyph}</span><small>{symbol.name}</small></button>{/each}</div>
			<div class="palette-footer"><span>{selectedSymbol.name}</span><label>Size <input type="range" min="18" max="72" bind:value={symbolSize} /></label></div>
		</section>
	{/if}

	<footer class="bottombar" class:hidden={reading || !controls}>
		<div class="footer-section"><button class="icon-button" class:active={fit === 'page'} title="Fit page" aria-label="Fit page" onclick={() => setFit('page')}><Square size={16} /></button><button class="icon-button" class:active={fit === 'width'} title="Fit width" aria-label="Fit width" onclick={() => setFit('width')}><Minus size={18} /></button><button class="icon-button" title="Zoom out" aria-label="Zoom out" onclick={() => setZoom(zoom - 0.1)}><ZoomOut size={17} /></button><span class="zoom-value">{Math.round(zoom * 100)}%</span><button class="icon-button" title="Zoom in" aria-label="Zoom in" onclick={() => setZoom(zoom + 0.1)}><ZoomIn size={17} /></button></div>
		<div class="footer-section"><button class:active={dual} class="text-button" onclick={() => { dual = !dual; persistPrefs(); void render(); }}><Columns2 size={15} /> {dual ? 'Single page' : 'Two pages'}</button><button class="icon-button" title="Show/hide annotations" aria-label="Show/hide annotations" onclick={toggleAnnotations}>{#if annotationsVisible}<Eye size={17} />{:else}<EyeOff size={17} />{/if}</button><button class="icon-button" title="Fullscreen" aria-label="Fullscreen" onclick={toggleFullScreen}><Maximize2 size={17} /></button><button class="text-button" onclick={() => (settingsOpen = !settingsOpen)}>Settings</button></div>
	</footer>

	{#if settingsOpen}
		<div class="settings-card"><strong>Viewer settings</strong><label><input type="checkbox" bind:checked={controls} /> Show controls</label><label><input type="checkbox" bind:checked={dual} /> Two-page view</label><label><input type="checkbox" bind:checked={annotationsVisible} /> Show annotations</label><label>Text size <input type="range" min="10" max="36" bind:value={textSize} /></label><button class="text-button" onclick={() => { settingsOpen = false; persistPrefs(); void render(); }}>Done</button></div>
	{/if}
</div>

<style>
	@font-face { font-family:Leland; src:url('/Leland.otf') format('opentype'); font-display:block; }
	:global(*) { box-sizing:border-box; }
	.viewer { --bg:#121210; --panel:#1a1a17; --line:rgba(255,255,255,.09); position:relative; width:100%; height:100%; min-height:0; overflow:hidden; background:var(--bg); color:#f5f5f4; font-family:Inter,ui-sans-serif,system-ui,sans-serif; }
	.topbar,.bottombar { position:relative; z-index:20; display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 14px; background:rgba(26,26,23,.95); border-bottom:1px solid var(--line); backdrop-filter:blur(18px); }.bottombar { border-top:1px solid var(--line); border-bottom:0; min-height:56px; }
	.topbar-left,.topbar-right,.page-controls,.footer-section,.tool-group,.color-row { display:flex; align-items:center; gap:6px; }.topbar-left,.topbar-right { flex:1; }.topbar-right { justify-content:flex-end; }.score-title { display:flex; flex-direction:column; min-width:0; margin-left:4px; }.score-title strong { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; max-width:min(42vw,520px); font-size:14px; }.score-title span { color:#8e8e86; font-size:11px; margin-top:2px; }.page-controls { justify-content:center; }
	.icon-button,.tool-button,.text-button { border:1px solid transparent; color:#b7b7ae; background:transparent; border-radius:10px; cursor:pointer; transition:background .15s ease,color .15s ease,transform .12s ease,border-color .15s ease; }.icon-button { width:36px; height:36px; display:grid; place-items:center; }.icon-button:hover,.tool-button:hover,.text-button:hover { color:#fff; background:rgba(255,255,255,.07); }.icon-button:active,.tool-button:active { transform:scale(.96); }.icon-button.active,.tool-button.active { color:#fff; background:#35352f; border-color:rgba(255,255,255,.1); }.icon-button:disabled { opacity:.3; cursor:not-allowed; }.text-button { min-height:36px; padding:7px 10px; display:flex; align-items:center; gap:5px; font-size:11px; }.page-controls input { width:48px; height:34px; border:1px solid var(--line); background:#11110f; color:#fff; border-radius:9px; text-align:center; outline:none; }.page-controls span { color:#77776f; font-size:12px; }
	.workspace { position:absolute; inset:57px 0 57px; overflow:auto; display:flex; justify-content:center; padding:28px; background:radial-gradient(circle at 50% 20%,#282823 0,#151512 44%,#10100e 100%); }.pages { display:flex; align-items:flex-start; justify-content:center; gap:22px; min-width:max-content; margin:auto; }.pages.dual { gap:14px; }.page-shell { position:relative; flex:0 0 auto; background:#fff; box-shadow:0 18px 55px rgba(0,0,0,.42),0 2px 10px rgba(0,0,0,.28); }.pdf-canvas,.ink-canvas { display:block; }.ink-canvas { position:absolute; inset:0; touch-action:none; pointer-events:none; }.ink-canvas.interactive { pointer-events:auto; cursor:crosshair; }
	.loading,.error { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); display:flex; flex-direction:column; align-items:center; gap:7px; padding:14px 18px; border:1px solid var(--line); border-radius:14px; background:rgba(26,26,23,.93); box-shadow:0 15px 40px rgba(0,0,0,.35); font-size:12px; color:#b8b8b0; }.loading span:first-child { width:18px; height:18px; border:2px solid #66665e; border-top-color:#fff; border-radius:50%; animation:spin .8s linear infinite; }.error strong { color:#fff; }.error span { max-width:340px; text-align:center; line-height:1.45; }@keyframes spin { to { transform:rotate(360deg); } }
	.annotation-bar { position:absolute; z-index:30; left:50%; bottom:68px; transform:translateX(-50%); display:flex; align-items:center; gap:7px; max-width:calc(100% - 24px); padding:7px; border:1px solid var(--line); border-radius:16px; background:rgba(28,28,25,.96); box-shadow:0 14px 45px rgba(0,0,0,.35); backdrop-filter:blur(18px); }.tool-button { min-width:48px; padding:8px 9px; display:flex; flex-direction:column; align-items:center; gap:3px; font-size:9px; }.divider { width:1px; height:32px; background:var(--line); }.color-row { margin-left:4px; }.swatch { width:17px; height:17px; border-radius:50%; border:2px solid transparent; background:var(--swatch); cursor:pointer; box-shadow:0 0 0 1px rgba(255,255,255,.1); }.swatch.selected { border-color:#fff; box-shadow:0 0 0 1px #111; }.range-label { display:flex; align-items:center; gap:5px; color:#8f8f87; font-size:10px; white-space:nowrap; }.range-label input { width:70px; }
	.symbol-palette { position:absolute; z-index:40; left:50%; bottom:124px; transform:translateX(-50%); width:min(760px,calc(100% - 24px)); max-height:min(54vh,510px); display:flex; flex-direction:column; overflow:hidden; border:1px solid var(--line); border-radius:18px; background:rgba(28,28,25,.98); box-shadow:0 22px 65px rgba(0,0,0,.5); backdrop-filter:blur(22px); }.palette-header { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:14px 16px 10px; border-bottom:1px solid var(--line); }.palette-header div { display:flex; flex-direction:column; }.palette-header strong { font-size:13px; }.palette-header span { color:#77776f; font-size:10px; margin-top:2px; }.palette-header input { width:180px; border:1px solid var(--line); border-radius:9px; background:#11110f; color:#fff; padding:8px 10px; outline:none; font-size:11px; }.category-row { display:flex; gap:4px; padding:8px 12px; overflow:auto; border-bottom:1px solid var(--line); }.category-row button { border:0; background:transparent; color:#85857d; border-radius:8px; padding:7px 9px; white-space:nowrap; cursor:pointer; font-size:10px; }.category-row button.active,.category-row button:hover { color:#fff; background:rgba(255,255,255,.08); }.symbol-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(76px,1fr)); gap:5px; overflow:auto; padding:10px; }.symbol-button { min-height:68px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:4px; border:1px solid transparent; background:rgba(255,255,255,.025); border-radius:10px; color:#f4f4ef; cursor:pointer; }.symbol-button:hover,.symbol-button.selected { background:rgba(255,255,255,.09); border-color:rgba(255,255,255,.12); }.symbol-button span { font:34px/1 Leland; }.symbol-button small { color:#85857d; font-size:8px; text-align:center; }.palette-footer { display:flex; align-items:center; justify-content:space-between; padding:10px 14px; border-top:1px solid var(--line); color:#8d8d85; font-size:10px; }
	.search-panel { position:absolute; z-index:35; top:58px; left:50%; transform:translateX(-50%); width:min(620px,calc(100% - 24px)); display:flex; align-items:center; gap:8px; padding:8px 10px; background:rgba(30,30,27,.98); border:1px solid var(--line); border-radius:0 0 14px 14px; box-shadow:0 12px 30px rgba(0,0,0,.35); }.search-panel input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:#fff; font-size:12px; }.search-panel span { color:#85857d; font-size:10px; white-space:nowrap; }.settings-card { position:absolute; z-index:50; right:12px; bottom:68px; width:230px; display:flex; flex-direction:column; gap:11px; padding:15px; background:#22221e; border:1px solid var(--line); border-radius:14px; box-shadow:0 18px 45px rgba(0,0,0,.4); font-size:11px; }.settings-card label { display:flex; align-items:center; justify-content:space-between; gap:8px; color:#aaa9a0; }.settings-card input[type=range] { width:90px; }.hidden { display:none !important; }.reading .workspace { inset:0; }.reading .pages { padding:20px; }
	@media (max-width:900px) { .annotation-bar { left:10px; right:10px; transform:none; justify-content:center; overflow:auto; }.tool-button { min-width:42px; }.tool-button span { display:none; }.divider,.range-label,.color-row { display:none; }.symbol-palette { bottom:122px; }.topbar-right .icon-button:nth-child(3),.topbar-right .icon-button:nth-child(4) { display:none; } }
	@media (max-width:620px) { .score-title { display:none; }.topbar { padding:8px; }.workspace { padding:14px; }.symbol-palette { max-height:62vh; }.palette-header input { width:120px; }.bottombar { padding:8px; }.footer-section .text-button { display:none; } }
	@media print { .topbar,.bottombar,.annotation-bar,.symbol-palette,.search-panel,.settings-card,.loading,.error { display:none !important; }.workspace { position:static; overflow:visible; padding:0; background:#fff; }.viewer { height:auto; overflow:visible; background:#fff; }.pages { display:block; }.page-shell { box-shadow:none; page-break-after:always; } }
</style>
