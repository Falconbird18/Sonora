<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as pdfjsLib from 'pdfjs-dist';
	import { db } from './db';
	import type { ScoreItem, Stroke, Point, SymbolStamp, TextNote } from './types';
	import { MUSIC_SYMBOLS, MUSIC_SYMBOL_CATEGORIES } from './musicSymbols';
	import {
		ArrowLeft, ArrowUpRight, Bookmark, BookmarkCheck, ChevronLeft, ChevronRight,
		Columns2, Download, Eraser, Eye, EyeOff, Highlighter, Maximize2, Minimize2,
		Minus, MousePointer2, Music2, PenTool, Printer, Redo2, Search, Settings2,
		Type, Undo2, X, ZoomIn, ZoomOut
	} from '@lucide/svelte';

	let { score, onClose }: { score: ScoreItem; onClose: () => void } = $props();
	type Tool = 'move' | 'pen' | 'highlighter' | 'eraser' | 'line' | 'arrow' | 'symbol' | 'text';
	type Fit = 'page' | 'width';
	type Snapshot = { strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[] };

	let pdf = $state<pdfjsLib.PDFDocumentProxy | null>(null);
	let page = $state(1);
	let pageInput = $state('1');
	let zoom = $state(1);
	let fit = $state<Fit>('page');
	let dual = $state(false);
	let loading = $state(false);
	let loadingText = $state('Opening score…');
	let error = $state('');
	let reading = $state(false);
	let settingsOpen = $state(false);
	let searchOpen = $state(false);
	let searchText = $state('');
	let searchStatus = $state('');
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
	let recentSymbols = $state<string[]>([]);

	let strokes = $state<Record<number, Stroke[]>>({});
	let stamps = $state<Record<number, SymbolStamp[]>>({});
	let notes = $state<Record<number, TextNote[]>>({});
	let history = $state<Record<number, Snapshot[]>>({});
	let historyIndex = $state<Record<number, number>>({});

	let host = $state<HTMLElement | null>(null);
	let leftPdf = $state<HTMLCanvasElement | null>(null);
	let rightPdf = $state<HTMLCanvasElement | null>(null);
	let leftInk = $state<HTMLCanvasElement | null>(null);
	let rightInk = $state<HTMLCanvasElement | null>(null);
	let generation = 0;
	let renderTasks: pdfjsLib.RenderTask[] = [];
	let resizeTimer: ReturnType<typeof setTimeout> | undefined;
	let saveTimers = new Map<number, ReturnType<typeof setTimeout>>();
	let drawing: { page: number; canvas: HTMLCanvasElement; pointerId: number; stroke?: Stroke; raf?: number } | null = null;

	const prefs = `sonora-viewer-${score.id}`;
	const maxCanvasPixels = 5000000;
	const colors = ['#c2410c', '#2563eb', '#15803d', '#a16207', '#7e22ce', '#111827', '#ffffff'];
	const pages = $derived(pdf ? (dual ? [Math.max(1, page % 2 === 0 ? page : page - 1), Math.min(pdf.numPages, (page % 2 === 0 ? page : page - 1) + 1)] : [page]) : [page]);
	const filteredSymbols = $derived(MUSIC_SYMBOLS.filter((symbol) => symbol.category === symbolCategory && (!symbolSearch.trim() || symbol.name.toLowerCase().includes(symbolSearch.toLowerCase()))));
	const recentSymbolObjects = $derived(recentSymbols.map((id) => MUSIC_SYMBOLS.find((symbol) => symbol.id === id)).filter((symbol): symbol is (typeof MUSIC_SYMBOLS)[number] => !!symbol));
	const canUndo = $derived((historyIndex[page] ?? 0) > 0);
	const canRedo = $derived((historyIndex[page] ?? 0) < (history[page]?.length ?? 1) - 1);

	onMount(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(prefs) || '{}');
			bookmarked = !!saved.bookmarked;
			dual = !!saved.dual;
			zoom = typeof saved.zoom === 'number' ? saved.zoom : 1;
			fit = saved.fit === 'width' ? 'width' : 'page';
			annotationsVisible = saved.annotationsVisible !== false;
			recentSymbols = Array.isArray(saved.recentSymbols) ? saved.recentSymbols : [];
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
		const observer = new ResizeObserver(() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(() => void render(), 150); });
		if (host) observer.observe(host);
		return () => {
			window.removeEventListener('keydown', key);
			observer.disconnect();
			clearTimeout(resizeTimer);
			cancelRender();
			for (const timer of saveTimers.values()) clearTimeout(timer);
			void pdf?.destroy();
		};
	});

	async function load() {
		loading = true;
		error = '';
		try {
			loadingText = 'Preparing PDF…';
			// A local Blob is already resident in IndexedDB. Passing an ArrayBuffer directly
			// is substantially more reliable than a hand-rolled range transport for local files.
			// Keep very large documents out of the thumbnail/library path and let PDF.js parse them once.
			const buffer = await score.pdfBlob.arrayBuffer();
			loadingText = `Loading ${score.totalPages || ''} pages…`;
			pdf = await pdfjsLib.getDocument({ data: new Uint8Array(buffer), isEvalSupported: false, useWorkerFetch: false }).promise;
			const records = await db.annotations.where('scoreId').equals(score.id).toArray();
			for (const record of records) {
				strokes[record.pageNum] = record.strokes || [];
				stamps[record.pageNum] = record.stamps || [];
				notes[record.pageNum] = record.notes || [];
				const initial = snapshot(record.pageNum);
				history[record.pageNum] = [initial];
				historyIndex[record.pageNum] = 0;
			}
			ensureHistory(page);
			await tick();
			await render();
		} catch (reason) {
			console.error('Sonora PDF load failed', reason);
			error = 'Sonora could not open this score. If the PDF is unusually large, try re-importing it.';
		} finally { loading = false; }
	}

	function cancelRender() { for (const task of renderTasks) { try { task.cancel(); } catch {} } renderTasks = []; }

	async function render() {
		if (!pdf || !host) return;
		cancelRender();
		const current = ++generation;
		loading = true;
		loadingText = 'Rendering page…';
		try {
			if (dual && host.clientWidth < 820) dual = false;
			for (let i = 0; i < pages.length; i++) {
				await renderPage(pages[i], i, current);
				if (current !== generation) return;
			}
		} catch (reason) {
			if (!(reason instanceof Error && reason.name === 'RenderingCancelledException') && current === generation) error = 'This page could not be rendered at the current size. Try Fit Page or reduce zoom.';
		} finally { if (current === generation) loading = false; }
	}

	async function renderPage(number: number, index: number, current: number) {
		if (!pdf || !host) return;
		const pdfPage = await pdf.getPage(number);
		try {
			if (current !== generation) return;
			const base = pdfPage.getViewport({ scale: 1 });
			const availableWidth = Math.max(280, dual ? (host.clientWidth - 100) / 2 : host.clientWidth - 64);
			const availableHeight = Math.max(280, host.clientHeight - 78);
			let scale = (fit === 'width' ? availableWidth / base.width : Math.min(availableWidth / base.width, availableHeight / base.height)) * zoom;
			const safeScale = Math.sqrt(maxCanvasPixels / Math.max(1, base.width * base.height));
			scale = Math.max(0.2, Math.min(3, scale, safeScale));
			const viewport = pdfPage.getViewport({ scale });
			const dpr = Math.min(window.devicePixelRatio || 1, 2);
			const widthPx = Math.ceil(viewport.width);
			const heightPx = Math.ceil(viewport.height);
			const pdfCanvas = index === 0 ? leftPdf : rightPdf;
			const inkCanvas = index === 0 ? leftInk : rightInk;
			if (!pdfCanvas || !inkCanvas) return;
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
			renderTasks.push(task);
			await task.promise;
			if (current === generation) redraw(number, inkCanvas);
		} finally { try { pdfPage.cleanup(); } catch {} }
	}

	function position(event: PointerEvent, canvas: HTMLCanvasElement): Point { const rect = canvas.getBoundingClientRect(); return { x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)), y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)), pressure: event.pressure || 0.5 }; }
	function pointToCanvas(point: Point, canvas: HTMLCanvasElement) { const rect = canvas.getBoundingClientRect(); return { x: point.x * rect.width, y: point.y * rect.height }; }
	function choose(nextTool: Tool) { tool = nextTool; }
	function ensureHistory(number: number) { if (!history[number]) { history[number] = [snapshot(number)]; historyIndex[number] = 0; } }
	function snapshot(number: number): Snapshot { return { strokes: structuredClone(strokes[number] || []), stamps: structuredClone(stamps[number] || []), notes: structuredClone(notes[number] || []) }; }
	function checkpoint(number: number) {
		ensureHistory(number);
		const list = history[number] || [];
		const index = historyIndex[number] ?? list.length - 1;
		const nextHistory = [...list.slice(0, index + 1), snapshot(number)].slice(-80);
		history[number] = nextHistory;
		historyIndex[number] = nextHistory.length - 1;
		scheduleSave(number);
	}
	function applySnapshot(number: number, state: Snapshot) { strokes[number] = structuredClone(state.strokes); stamps[number] = structuredClone(state.stamps); notes[number] = structuredClone(state.notes); redraw(number, number === pages[0] ? leftInk : rightInk); scheduleSave(number); }
	function undo() { const i = historyIndex[page] ?? 0; if (i <= 0) return; historyIndex[page] = i - 1; applySnapshot(page, history[page][i - 1]); }
	function redo() { const i = historyIndex[page] ?? 0; const list = history[page] || []; if (i >= list.length - 1) return; historyIndex[page] = i + 1; applySnapshot(page, list[i + 1]); }
	function scheduleSave(number: number) { const old = saveTimers.get(number); if (old) clearTimeout(old); saveTimers.set(number, setTimeout(() => void saveAnnotations(number), 250)); }
	async function saveAnnotations(number: number) { await db.annotations.put({ id: `${score.id}:${number}`, scoreId: score.id, pageNum: number, strokes: $state.snapshot(strokes[number] || []), stamps: $state.snapshot(stamps[number] || []), notes: $state.snapshot(notes[number] || []) }); }

	function begin(event: PointerEvent, number: number, canvas: HTMLCanvasElement) {
		if (tool === 'move' || reading) return;
		event.preventDefault();
		canvas.setPointerCapture(event.pointerId);
		const point = position(event, canvas);
		if (tool === 'symbol') {
			stamps[number] = [...(stamps[number] || []), { id: crypto.randomUUID(), symbol: selectedSymbol.glyph, label: selectedSymbol.name, x: point.x, y: point.y, fontSize: symbolSize, color }];
			recentSymbols = [selectedSymbol.id, ...recentSymbols.filter((id) => id !== selectedSymbol.id)].slice(0, 8);
			persistPrefs(); checkpoint(number); redraw(number, canvas); return;
		}
		if (tool === 'text') {
			const text = window.prompt('Text annotation');
			if (text?.trim()) { notes[number] = [...(notes[number] || []), { id: crypto.randomUUID(), text: text.trim(), x: point.x, y: point.y, fontSize: textSize, color }]; checkpoint(number); redraw(number, canvas); }
			return;
		}
		if (tool === 'eraser') { drawing = { page: number, canvas, pointerId: event.pointerId }; erase(point, number, canvas, false); return; }
		const stroke: Stroke = { id: crypto.randomUUID(), tool: tool === 'highlighter' ? 'highlighter' : 'pen', kind: tool === 'line' ? 'line' : tool === 'arrow' ? 'arrow' : 'freehand', color, width, points: [point] };
		ensureHistory(number); strokes[number] = [...(strokes[number] || []), stroke]; drawing = { page: number, canvas, pointerId: event.pointerId, stroke }; redraw(number, canvas);
	}
	function move(event: PointerEvent) {
		if (!drawing) return;
		for (const pointEvent of event.getCoalescedEvents?.() || [event]) {
			if (drawing.stroke) {
				const stroke = (strokes[drawing.page] || []).find((item) => item.id === drawing?.stroke?.id);
				if (stroke) { const point = position(pointEvent, drawing.canvas); stroke.points = stroke.kind === 'line' || stroke.kind === 'arrow' ? [stroke.points[0], point] : [...stroke.points, point]; }
			} else erase(position(pointEvent, drawing.canvas), drawing.page, drawing.canvas, false);
		}
		if (!drawing.raf) drawing.raf = requestAnimationFrame(() => { if (drawing) redraw(drawing.page, drawing.canvas); if (drawing) drawing.raf = undefined; });
	}
	function end() { if (!drawing) return; const active = drawing; if (active.raf) cancelAnimationFrame(active.raf); drawing = null; try { active.canvas.releasePointerCapture(active.pointerId); } catch {} redraw(active.page, active.canvas); checkpoint(active.page); }
	function erase(point: Point, number: number, canvas: HTMLCanvasElement | null, save = true) { const radius = Math.max(0.006, width / 900); const before = strokes[number] || []; const after = before.filter((stroke) => !stroke.points.some((candidate) => Math.hypot(candidate.x - point.x, candidate.y - point.y) < radius)); if (after.length !== before.length) { strokes[number] = after; if (canvas) redraw(number, canvas); if (save) checkpoint(number); } }

	function redraw(number: number, canvas: HTMLCanvasElement | null) {
		if (!canvas) return;
		const context = canvas.getContext('2d')!;
		const rect = canvas.getBoundingClientRect();
		const scale = canvas.width / Math.max(1, rect.width);
		context.setTransform(scale, 0, 0, scale, 0, 0);
		context.clearRect(0, 0, rect.width, rect.height);
		if (!annotationsVisible) return;
		for (const stroke of strokes[number] || []) drawStroke(context, stroke, canvas);
		for (const stamp of stamps[number] || []) { const p = pointToCanvas({ x: stamp.x, y: stamp.y }, canvas); context.save(); context.font = `${stamp.fontSize}px Leland`; context.fillStyle = stamp.color; context.textAlign = 'center'; context.textBaseline = 'middle'; context.fillText(stamp.symbol, p.x, p.y); context.restore(); }
		for (const note of notes[number] || []) { const p = pointToCanvas({ x: note.x, y: note.y }, canvas); context.save(); context.font = `600 ${note.fontSize}px system-ui,sans-serif`; context.fillStyle = note.color; context.textBaseline = 'top'; context.shadowColor = 'white'; context.shadowBlur = 3; context.fillText(note.text, p.x, p.y); context.restore(); }
	}
	function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, canvas: HTMLCanvasElement) {
		if (!stroke.points.length) return;
		const points = stroke.points.map((point) => pointToCanvas(point, canvas));
		context.save(); context.strokeStyle = stroke.color; context.fillStyle = stroke.color; context.lineWidth = stroke.width; context.lineCap = 'round'; context.lineJoin = 'round'; if (stroke.tool === 'highlighter') context.globalAlpha = 0.28;
		if (stroke.kind === 'line' || stroke.kind === 'arrow') { const start = points[0]; const end = points[points.length - 1]; context.beginPath(); context.moveTo(start.x, start.y); context.lineTo(end.x, end.y); context.stroke(); if (stroke.kind === 'arrow') { const angle = Math.atan2(end.y - start.y, end.x - start.x); const size = Math.max(8, stroke.width * 3); context.beginPath(); context.moveTo(end.x, end.y); context.lineTo(end.x - size * Math.cos(angle - Math.PI / 6), end.y - size * Math.sin(angle - Math.PI / 6)); context.lineTo(end.x - size * Math.cos(angle + Math.PI / 6), end.y - size * Math.sin(angle + Math.PI / 6)); context.closePath(); context.fill(); } } else { context.beginPath(); context.moveTo(points[0].x, points[0].y); for (let i = 1; i < points.length; i++) context.lineTo(points[i].x, points[i].y); context.stroke(); }
		context.restore();
	}

	function setZoom(value: number) { zoom = Math.max(0.4, Math.min(2.5, Number(value.toFixed(2)))); persistPrefs(); void render(); }
	function next() { if (!pdf) return; page = Math.min(pdf.numPages, dual ? page + 2 : page + 1); pageInput = String(page); void render(); }
	function previous() { page = Math.max(1, dual ? page - 2 : page - 1); pageInput = String(page); void render(); }
	function goToPage() { const value = Math.max(1, Math.min(pdf?.numPages || 1, Number.parseInt(pageInput, 10) || 1)); page = value; pageInput = String(value); void render(); }
	function setFit(value: Fit) { fit = value; zoom = 1; persistPrefs(); void render(); }
	function persistPrefs() { localStorage.setItem(prefs, JSON.stringify({ bookmarked, dual, zoom, fit, annotationsVisible, recentSymbols })); }
	function toggleBookmark() { bookmarked = !bookmarked; persistPrefs(); }
	async function fullscreen() { if (!document.fullscreenElement) await host?.requestFullscreen(); else await document.exitFullscreen(); }
	async function searchPdf() {
		if (!pdf || !searchText.trim()) return;
		searchStatus = 'Searching…';
		const needle = searchText.trim().toLowerCase();
		for (let number = 1; number <= pdf.numPages; number++) { const pdfPage = await pdf.getPage(number); try { const content = await pdfPage.getTextContent(); const text = content.items.map((item) => 'str' in item ? item.str : '').join(' ').toLowerCase(); if (text.includes(needle)) { page = number; pageInput = String(number); searchStatus = `Found on page ${number}`; void render(); return; } } finally { try { pdfPage.cleanup(); } catch {} } }
		searchStatus = 'Not found';
	}
	function download() { const url = URL.createObjectURL(score.pdfBlob); const a = document.createElement('a'); a.href = url; a.download = `${score.title}.pdf`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
	function print() { window.print(); }
</script>

<svelte:head><title>{score.title} — Sonora</title></svelte:head>

<div class="viewer" bind:this={host} class:reading>
	<header class="topbar" class:hidden={reading}>
		<div class="left"><button class="icon" title="Back to library" aria-label="Back" onclick={onClose}><ArrowLeft size={19} /></button><div class="title"><strong>{score.title}</strong><span>{score.composer}</span></div></div>
		<div class="pages"><button class="icon" title="Previous page" onclick={previous} disabled={page <= 1}><ChevronLeft size={18} /></button><input aria-label="Page number" bind:value={pageInput} onkeydown={(event) => event.key === 'Enter' && goToPage()} onblur={goToPage} /><span>/ {pdf?.numPages ?? score.totalPages}</span><button class="icon" title="Next page" onclick={next} disabled={!pdf || page >= pdf.numPages}><ChevronRight size={18} /></button></div>
		<div class="right"><button class:active={bookmarked} class="icon" title="Bookmark" onclick={toggleBookmark}>{#if bookmarked}<BookmarkCheck size={18} />{:else}<Bookmark size={18} />{/if}</button><button class="icon" title="Search score" onclick={() => (searchOpen = !searchOpen)}><Search size={18} /></button><button class="icon" title="Print" onclick={print}><Printer size={18} /></button><button class="icon" title="Download PDF" onclick={download}><Download size={18} /></button></div>
	</header>
	{#if searchOpen && !reading}<div class="search"><Search size={16} /><input autofocus bind:value={searchText} placeholder="Find text in score…" onkeydown={(event) => event.key === 'Enter' && searchPdf()} /><button onclick={searchPdf}>Find</button><span>{searchStatus}</span><button class="icon" onclick={() => (searchOpen = false)} aria-label="Close"><X size={16} /></button></div>{/if}

	<main class="workspace">
		<div class="page-row" class:dual>
			{#each pages as number, index}<div class="page-shell"><canvas class="pdf" bind:this={index === 0 ? leftPdf : rightPdf}></canvas><canvas class="ink" class:interactive={tool !== 'move' && !reading} bind:this={index === 0 ? leftInk : rightInk} onpointerdown={(event) => begin(event, number, index === 0 ? leftInk! : rightInk!)} onpointermove={move} onpointerup={end} onpointercancel={end}></canvas></div>{/each}
		</div>
		{#if loading}<div class="status"><span class="spinner"></span>{loadingText}</div>{/if}
		{#if error}<div class="error"><strong>Unable to display score</strong><span>{error}</span><button onclick={() => void load()}>Retry</button></div>{/if}
	</main>

	{#if !reading}<aside class="toolbar"><button class:active={tool === 'move'} class="tool" title="Move" onclick={() => choose('move')}><MousePointer2 size={18} /><small>Move</small></button><button class:active={tool === 'pen'} class="tool" title="Pen (P)" onclick={() => choose('pen')}><PenTool size={18} /><small>Pen</small></button><button class:active={tool === 'highlighter'} class="tool" title="Highlighter (H)" onclick={() => choose('highlighter')}><Highlighter size={18} /><small>Highlight</small></button><button class:active={tool === 'line'} class="tool" title="Line" onclick={() => choose('line')}><Minus size={18} /><small>Line</small></button><button class:active={tool === 'arrow'} class="tool" title="Arrow" onclick={() => choose('arrow')}><ArrowUpRight size={18} /><small>Arrow</small></button><button class:active={tool === 'eraser'} class="tool" title="Eraser (E)" onclick={() => choose('eraser')}><Eraser size={18} /><small>Erase</small></button><button class:active={tool === 'symbol'} class="tool" title="Musical symbols (S)" onclick={() => choose('symbol')}><Music2 size={18} /><small>Symbols</small></button><button class:active={tool === 'text'} class="tool" title="Text (T)" onclick={() => choose('text')}><Type size={18} /><small>Text</small></button><span class="separator"></span><button class="icon" title="Undo" onclick={undo} disabled={!canUndo}><Undo2 size={18} /></button><button class="icon" title="Redo" onclick={redo} disabled={!canRedo}><Redo2 size={18} /></button><div class="colors">{#each colors as swatch}<button class:selected={color === swatch} class="swatch" style={`--color:${swatch}`} title={swatch} onclick={() => (color = swatch)}></button>{/each}</div><label class="size">Size <input type="range" min="1" max="14" bind:value={width} /></label></aside>{/if}

	{#if tool === 'symbol' && !reading}<section class="palette"><div class="palette-head"><div><strong>Musical symbols</strong><span>Leland • click a symbol, then click the score</span></div><input bind:value={symbolSearch} placeholder="Search" /></div>{#if recentSymbolObjects.length}<div class="recent"><span>Recent</span>{#each recentSymbolObjects as symbol}<button class:selected={selectedSymbol.id === symbol.id} title={symbol.name} onclick={() => (selectedSymbol = symbol)}><span>{symbol.glyph}</span></button>{/each}</div>{/if}<nav class="categories">{#each MUSIC_SYMBOL_CATEGORIES as category}<button class:active={category === symbolCategory} onclick={() => (symbolCategory = category)}>{category}</button>{/each}</nav><div class="symbols">{#each filteredSymbols as symbol}<button class:selected={selectedSymbol.id === symbol.id} title={symbol.name} onclick={() => (selectedSymbol = symbol)}><span>{symbol.glyph}</span><small>{symbol.name}</small></button>{/each}</div><div class="palette-foot"><span>{selectedSymbol.name}</span><label>Size <input type="range" min="18" max="72" bind:value={symbolSize} /></label></div></section>{/if}

	<footer class="bottom" class:hidden={reading}><div class="group"><button class="icon" title="Fit page" class:active={fit === 'page'} onclick={() => setFit('page')}>□</button><button class="icon" title="Fit width" class:active={fit === 'width'} onclick={() => setFit('width')}>↔</button><button class="icon" title="Zoom out" onclick={() => setZoom(zoom - 0.1)}><ZoomOut size={17} /></button><span>{Math.round(zoom * 100)}%</span><button class="icon" title="Zoom in" onclick={() => setZoom(zoom + 0.1)}><ZoomIn size={17} /></button></div><div class="group"><button class="text" class:active={dual} onclick={() => { dual = !dual; persistPrefs(); void render(); }}><Columns2 size={16} />{dual ? 'Single page' : 'Two pages'}</button><button class="icon" title="Toggle annotations" onclick={() => { annotationsVisible = !annotationsVisible; persistPrefs(); void render(); }}>{annotationsVisible ? <Eye size={17} /> : <EyeOff size={17} />}</button><button class="icon" title="Fullscreen" onclick={fullscreen}>{#if document.fullscreenElement}<Minimize2 size={17} />{:else}<Maximize2 size={17} />{/if}</button><button class="icon" title="Settings" onclick={() => (settingsOpen = !settingsOpen)}><Settings2 size={17} /></button></div></footer>
	{#if settingsOpen}<div class="settings"><strong>Viewer settings</strong><label><input type="checkbox" bind:checked={dual} /> Two-page view</label><label><input type="checkbox" bind:checked={annotationsVisible} /> Show annotations</label><label><input type="checkbox" bind:checked={reading} /> Reading mode</label><button onclick={() => { settingsOpen = false; persistPrefs(); void render(); }}>Done</button></div>{/if}
</div>

<style>
	@font-face { font-family:Leland; src:url('/Leland.otf') format('opentype'); font-display:block; }
	:global(*) { box-sizing:border-box; }
	.viewer { position:relative; width:100%; height:100%; overflow:hidden; background:#10100e; color:#f4f4f0; font-family:Inter,ui-sans-serif,system-ui,sans-serif; }
	.topbar,.bottom { z-index:20; position:relative; display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 13px; background:rgba(25,25,22,.96); border-bottom:1px solid rgba(255,255,255,.08); backdrop-filter:blur(18px); }.bottom { border-top:1px solid rgba(255,255,255,.08); border-bottom:0; min-height:54px; }.left,.right,.pages,.group { display:flex; align-items:center; gap:5px; }.left,.right { flex:1; }.right { justify-content:flex-end; }.title { min-width:0; display:flex; flex-direction:column; }.title strong { max-width:42vw; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }.title span { color:#85857d; font-size:10px; margin-top:2px; }.icon,.tool,.text { border:1px solid transparent; background:transparent; color:#aead a5; color:#aead a5; border-radius:9px; cursor:pointer; }.icon { width:35px; height:35px; display:grid; place-items:center; }.icon:hover,.tool:hover,.text:hover,.icon.active,.tool.active,.text.active { background:rgba(255,255,255,.08); color:#fff; }.icon:disabled { opacity:.3; cursor:not-allowed; }.pages input { width:48px; height:32px; border-radius:8px; border:1px solid rgba(255,255,255,.1); background:#0d0d0b; color:#fff; text-align:center; outline:none; }.pages span,.bottom span { color:#77776f; font-size:11px; }.workspace { position:absolute; inset:55px 0 54px; overflow:auto; padding:28px; display:flex; justify-content:center; background:radial-gradient(circle at 50% 18%,#292923 0,#151512 48%,#0f0f0d 100%); }.page-row { display:flex; gap:22px; align-items:flex-start; margin:auto; min-width:max-content; }.page-row.dual { gap:14px; }.page-shell { position:relative; flex:0 0 auto; background:white; box-shadow:0 18px 55px rgba(0,0,0,.42); }.pdf,.ink { display:block; }.ink { position:absolute; inset:0; touch-action:none; pointer-events:none; }.ink.interactive { pointer-events:auto; cursor:crosshair; }.status,.error { position:absolute; left:50%; top:50%; transform:translate(-50%,-50%); padding:14px 18px; border-radius:14px; border:1px solid rgba(255,255,255,.1); background:rgba(28,28,25,.95); box-shadow:0 18px 50px rgba(0,0,0,.4); display:flex; align-items:center; gap:9px; color:#b6b6ae; font-size:12px; }.spinner { width:17px; height:17px; border:2px solid #55554e; border-top-color:white; border-radius:50%; animation:spin .8s linear infinite; }.error { flex-direction:column; }.error strong { color:white; }.error span { max-width:320px; text-align:center; line-height:1.4; }.error button,.search button,.settings button { border:0; border-radius:8px; padding:7px 10px; background:#fff; color:#111; cursor:pointer; font-size:11px; }.toolbar { z-index:30; position:absolute; left:50%; bottom:65px; transform:translateX(-50%); display:flex; align-items:center; gap:4px; max-width:calc(100% - 20px); padding:6px; border-radius:15px; border:1px solid rgba(255,255,255,.1); background:rgba(29,29,26,.97); box-shadow:0 18px 50px rgba(0,0,0,.4); backdrop-filter:blur(18px); }.tool { width:49px; padding:7px 4px; display:flex; flex-direction:column; align-items:center; gap:3px; }.tool small { font-size:8px; }.separator { width:1px; height:30px; background:rgba(255,255,255,.09); margin:0 3px; }.colors { display:flex; gap:4px; margin-left:3px; }.swatch { width:17px; height:17px; border-radius:50%; border:2px solid transparent; background:var(--color); cursor:pointer; }.swatch.selected { border-color:#fff; box-shadow:0 0 0 1px #111; }.size { color:#888880; font-size:9px; display:flex; align-items:center; gap:4px; white-space:nowrap; }.size input { width:68px; }.palette { z-index:40; position:absolute; left:50%; bottom:120px; transform:translateX(-50%); width:min(760px,calc(100% - 20px)); max-height:min(58vh,560px); overflow:hidden; display:flex; flex-direction:column; background:rgba(28,28,25,.98); border:1px solid rgba(255,255,255,.1); border-radius:17px; box-shadow:0 24px 70px rgba(0,0,0,.55); }.palette-head { display:flex; justify-content:space-between; align-items:center; gap:12px; padding:13px 15px 10px; border-bottom:1px solid rgba(255,255,255,.08); }.palette-head div { display:flex; flex-direction:column; }.palette-head strong { font-size:13px; }.palette-head span { color:#77776f; font-size:9px; margin-top:3px; }.palette-head input { width:170px; padding:8px 9px; border-radius:8px; border:1px solid rgba(255,255,255,.1); background:#11110f; color:white; outline:none; font-size:11px; }.recent { display:flex; align-items:center; gap:4px; padding:7px 11px; border-bottom:1px solid rgba(255,255,255,.07); }.recent > span { color:#77776f; font-size:9px; margin-right:3px; }.recent button { width:34px; height:34px; border:1px solid transparent; border-radius:8px; background:rgba(255,255,255,.03); color:white; cursor:pointer; }.recent button.selected,.recent button:hover { background:rgba(255,255,255,.1); border-color:rgba(255,255,255,.1); }.recent button span { font:23px/1 Leland; }.categories { display:flex; gap:3px; padding:7px 10px; overflow:auto; border-bottom:1px solid rgba(255,255,255,.07); }.categories button { border:0; background:transparent; color:#85857d; padding:6px 8px; border-radius:7px; white-space:nowrap; cursor:pointer; font-size:9px; }.categories button.active,.categories button:hover { color:white; background:rgba(255,255,255,.08); }.symbols { overflow:auto; padding:9px; display:grid; grid-template-columns:repeat(auto-fill,minmax(76px,1fr)); gap:5px; }.symbols button { min-height:68px; border:1px solid transparent; border-radius:9px; background:rgba(255,255,255,.025); color:white; cursor:pointer; display:flex; flex-direction:column; justify-content:center; align-items:center; gap:4px; }.symbols button:hover,.symbols button.selected { background:rgba(255,255,255,.09); border-color:rgba(255,255,255,.12); }.symbols span { font:34px/1 Leland; }.symbols small { color:#85857d; font-size:8px; text-align:center; }.palette-foot { display:flex; justify-content:space-between; align-items:center; padding:9px 13px; border-top:1px solid rgba(255,255,255,.07); color:#888880; font-size:10px; }.palette-foot label { display:flex; gap:5px; align-items:center; }.palette-foot input { width:90px; }.search { z-index:35; position:absolute; top:55px; left:50%; transform:translateX(-50%); width:min(620px,calc(100% - 20px)); display:flex; align-items:center; gap:7px; padding:7px 9px; background:rgba(30,30,27,.98); border:1px solid rgba(255,255,255,.1); border-top:0; border-radius:0 0 13px 13px; }.search input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:white; font-size:11px; }.search span { color:#85857d; font-size:9px; white-space:nowrap; }.settings { z-index:50; position:absolute; right:12px; bottom:64px; width:230px; padding:14px; display:flex; flex-direction:column; gap:11px; border:1px solid rgba(255,255,255,.1); border-radius:13px; background:#22221e; box-shadow:0 18px 50px rgba(0,0,0,.45); font-size:11px; }.settings label { display:flex; justify-content:space-between; color:#aaa9a0; }.hidden { display:none !important; }.reading .workspace { inset:0; }.reading .ink { pointer-events:none !important; }
	@keyframes spin { to { transform:rotate(360deg); } }
	@media (max-width:850px) { .tool { width:40px; }.tool small,.separator,.colors,.size { display:none; }.toolbar { left:10px; right:10px; transform:none; justify-content:center; overflow:auto; }.title { display:none; }.right .icon:nth-child(3),.right .icon:nth-child(4) { display:none; } }
	@media (max-width:600px) { .workspace { padding:14px; }.palette { bottom:112px; max-height:65vh; }.palette-head input { width:120px; }.bottom { padding:7px; }.text { display:none; } }
	@media print { .topbar,.bottom,.toolbar,.palette,.search,.settings,.status,.error { display:none !important; }.viewer { height:auto; overflow:visible; background:white; }.workspace { position:static; overflow:visible; padding:0; background:white; }.page-row { display:block; }.page-shell { box-shadow:none; page-break-after:always; } }
</style>
