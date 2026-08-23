<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as pdfjsLib from 'pdfjs-dist';
	import { db } from './db';
	import type { Point, ScoreItem, Stroke } from './types';
	import {
		ArrowLeft, ChevronLeft, ChevronRight, Download, Eraser, Highlighter,
		Minus, MousePointer2, PenTool, Redo2, RotateCcw, Search, Settings2,
		Undo2, ZoomIn, ZoomOut, Maximize2, Minimize2, Eye, EyeOff, Printer,
		X
	} from 'lucide-svelte';

	let { score, onClose }: { score: ScoreItem; onClose: () => void } = $props();
	type Tool = 'move' | 'pen' | 'highlighter' | 'eraser' | 'line' | 'arrow';
	type Fit = 'page' | 'width' | 'free';
	type History = { strokes: Stroke[] };

	class BlobRangeTransport extends pdfjsLib.PDFDataRangeTransport {
		private blob: Blob;
		private requests = new Map<string, Promise<void>>();
		constructor(blob: Blob) {
			super(blob.size, null, false, 'score.pdf');
			this.blob = blob;
		}
		requestDataRange(begin: number, end: number) {
			const key = `${begin}:${end}`;
			if (this.requests.has(key)) return;
			const request = this.blob.slice(begin, end).arrayBuffer().then((buffer) => {
				this.onDataRange(begin, new Uint8Array(buffer));
				this.onDataProgress(Math.min(end, this.blob.size));
			}).catch((error) => this.abort(error));
			this.requests.set(key, request);
			void request.finally(() => this.requests.delete(key));
		}
		abort(_reason?: unknown) { this.requests.clear(); }
	}

	let pdfDoc = $state<pdfjsLib.PDFDocumentProxy | null>(null);
	let transport: BlobRangeTransport | null = null;
	let page = $state(1);
	let zoom = $state(1);
	let fit = $state<Fit>('page');
	let dual = $state(false);
	let reading = $state(false);
	let controls = $state(true);
	let showAnnotations = $state(true);
	let showSearch = $state(false);
	let settings = $state(false);
	let searchText = $state('');
	let searchResult = $state('');
	let error = $state('');
	let loading = $state(false);
	let tool = $state<Tool>('move');
	let annotationMode = $state(false);
	let color = $state('#ef4444');
	let width = $state(3);
	let strokes = $state<Record<number, Stroke[]>>({});
	let histories = $state<Record<number, History[]>>({});
	let historyIndex = $state<Record<number, number>>({});
	let leftPdf = $state<HTMLCanvasElement | null>(null);
	let rightPdf = $state<HTMLCanvasElement | null>(null);
	let host = $state<HTMLElement | null>(null);
	let renderToken = 0;
	let renderTasks: pdfjsLib.RenderTask[] = [];
	let saveTimers = new Map<number, ReturnType<typeof setTimeout>>();
	let drawing: { page: number; canvas: HTMLCanvasElement; stroke?: Stroke; pointerId: number } | null = null;
	let pageInput = $state('1');
	let bookmarked = $state(false);
	let prefsKey = `sonora-viewer-${score.id}`;

	const colors = ['#ef4444', '#2563eb', '#16a34a', '#eab308', '#9333ea', '#111827'];
	const maxPixels = 7_000_000;
	const pages = $derived(dual ? [page % 2 === 0 ? page : Math.max(1, page - 1), Math.min(pdfDoc?.numPages ?? 1, (page % 2 === 0 ? page : Math.max(1, page - 1)) + 1)] : [page]);

	onMount(() => {
		void load();
		try {
			const saved = JSON.parse(localStorage.getItem(prefsKey) || '{}');
			bookmarked = !!saved.bookmarked;
			dual = !!saved.dual;
			zoom = typeof saved.zoom === 'number' ? saved.zoom : 1;
			showAnnotations = saved.showAnnotations !== false;
		} catch {}
		const keydown = (e: KeyboardEvent) => {
			if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
			if (e.key === 'ArrowRight') next();
			else if (e.key === 'ArrowLeft') previous();
			else if (e.key === '+' || e.key === '=') setZoom(zoom + .1);
			else if (e.key === '-') setZoom(zoom - .1);
			else if (e.key === 'Escape') { settings = false; showSearch = false; annotationMode = false; tool = 'move'; }
			else if (e.key.toLowerCase() === 'p') selectTool('pen');
			else if (e.key.toLowerCase() === 'h') selectTool('highlighter');
			else if (e.key.toLowerCase() === 'e') selectTool('eraser');
			else if (e.key.toLowerCase() === 'r') resetView();
			else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
			else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
		};
		window.addEventListener('keydown', keydown);
		return () => {
			window.removeEventListener('keydown', keydown);
			cancelRenders();
			transport?.abort();
			void pdfDoc?.destroy();
			for (const t of saveTimers.values()) clearTimeout(t);
		};
	});

	async function load() {
		loading = true; error = '';
		try {
			transport = new BlobRangeTransport(score.pdfBlob);
			pdfDoc = await pdfjsLib.getDocument({ range: transport, rangeChunkSize: 512 * 1024, disableStream: true, disableAutoFetch: true, isEvalSupported: false }).promise;
			const records = await db.annotations.where('scoreId').equals(score.id).toArray();
			for (const record of records) {
				strokes[record.pageNum] = record.strokes || [];
				histories[record.pageNum] = [{ strokes: structuredClone(strokes[record.pageNum]) }];
				historyIndex[record.pageNum] = 0;
			}
			await tick();
			await render();
		} catch (e) {
			console.error(e);
			error = 'Sonora could not open this PDF. Try reopening or re-importing the score.';
		} finally { loading = false; }
	}

	function cancelRenders() {
		for (const task of renderTasks) { try { task.cancel(); } catch {} }
		renderTasks = [];
	}

	async function render() {
		if (!pdfDoc || !host) return;
		cancelRenders();
		const token = ++renderToken;
		loading = true; error = '';
		try {
			if (dual && host.clientWidth < 800) dual = false;
			await Promise.all(pages.map((p, i) => renderPage(p, i === 0 ? leftPdf : rightPdf, token)));
		} catch (e) {
			if (!(e instanceof Error && e.name === 'RenderingCancelledException') && token === renderToken) {
				error = 'This page could not be rendered at the current size. Try Fit Page or reduce zoom.';
			}
		} finally { if (token === renderToken) loading = false; }
	}

	async function renderPage(pageNumber: number, canvas: HTMLCanvasElement | null, token: number) {
		if (!pdfDoc || !canvas || !host) return;
		const pdfPage = await pdfDoc.getPage(pageNumber);
		if (token !== renderToken) return;
		const base = pdfPage.getViewport({ scale: 1 });
		const availableW = dual ? Math.max(280, (host.clientWidth - 100) / 2) : Math.max(280, host.clientWidth - 70);
		const availableH = Math.max(300, host.clientHeight - 90);
		let scale = fit === 'width' ? availableW / base.width : Math.min(availableW / base.width, availableH / base.height);
		if (fit === 'free') scale *= zoom; else scale *= zoom;
		scale = Math.max(.2, Math.min(3, scale));
		if (base.width * scale * base.height * scale > maxPixels) scale = Math.sqrt(maxPixels / (base.width * base.height));
		const viewport = pdfPage.getViewport({ scale });
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = Math.ceil(viewport.width * dpr);
		canvas.height = Math.ceil(viewport.height * dpr);
		canvas.style.width = `${Math.ceil(viewport.width)}px`;
		canvas.style.height = `${Math.ceil(viewport.height)}px`;
		const ctx = canvas.getContext('2d', { alpha: false })!;
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, viewport.width, viewport.height);
		const task = pdfPage.render({ canvasContext: ctx, viewport });
		renderTasks.push(task);
		await task.promise;
	}

	function point(e: PointerEvent, canvas: HTMLCanvasElement): Point {
		const r = canvas.getBoundingClientRect();
		return { x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)), y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)), pressure: e.pressure || .5 };
	}
	function selectTool(next: Tool) { tool = next; annotationMode = next !== 'move'; }
	function canvasForPage(p: number) { return p === pages[0] ? leftPdf : rightPdf; }

	function beginDraw(e: PointerEvent, p: number, canvas: HTMLCanvasElement) {
		if (!annotationMode || tool === 'move') return;
		e.preventDefault(); canvas.setPointerCapture(e.pointerId);
		const start = point(e, canvas);
		if (tool === 'eraser') { drawing = { page: p, canvas, pointerId: e.pointerId }; erase(start, p); return; }
		const stroke: Stroke = { id: crypto.randomUUID(), tool: tool === 'highlighter' ? 'highlighter' : 'pen', kind: tool === 'line' ? 'line' : tool === 'arrow' ? 'arrow' : 'freehand', color, width, points: [start] };
		strokes = { ...strokes, [p]: [...(strokes[p] || []), stroke] };
		drawing = { page: p, canvas, pointerId: e.pointerId, stroke };
		redrawOverlay(p, canvas);
	}
	function moveDraw(e: PointerEvent) {
		if (!drawing) return;
		const events = e.getCoalescedEvents?.() || [e];
		if (drawing.stroke) {
			const current = strokes[drawing.page] || [];
			const target = current.find((s) => s.id === drawing!.stroke!.id);
			if (target) for (const ev of events) target.points.push(point(ev, drawing!.canvas));
		} else for (const ev of events) erase(point(ev, drawing.canvas), drawing.page, false);
		redrawOverlay(drawing.page, drawing.canvas);
	}
	function endDraw() {
		if (!drawing) return;
		const d = drawing; drawing = null;
		try { d.canvas.releasePointerCapture(d.pointerId); } catch {}
		redrawOverlay(d.page, d.canvas);
		checkpoint(d.page);
	}
	function erase(p: Point, pageNumber: number, save = true) {
		const radius = Math.max(.006, width / 900);
		const before = strokes[pageNumber] || [];
		const after = before.filter((s) => !s.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < radius));
		if (after.length !== before.length) {
			strokes = { ...strokes, [pageNumber]: after };
			redrawOverlay(pageNumber, canvasForPage(pageNumber));
			if (save) checkpoint(pageNumber);
		}
	}
	function drawStroke(ctx: CanvasRenderingContext2D, s: Stroke, canvas: HTMLCanvasElement) {
		if (!s.points.length) return;
		const r = canvas.getBoundingClientRect();
		const xy = (p: Point) => ({ x: p.x * r.width, y: p.y * r.height });
		ctx.save(); ctx.strokeStyle = s.color; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
		ctx.lineWidth = s.tool === 'highlighter' ? Math.max(12, s.width * 5) : s.width;
		if (s.tool === 'highlighter') { ctx.globalAlpha = .35; ctx.globalCompositeOperation = 'multiply'; }
		if (s.kind === 'line' || s.kind === 'arrow') {
			const a = xy(s.points[0]), b = xy(s.points[s.points.length - 1]);
			ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
			if (s.kind === 'arrow') {
				const angle = Math.atan2(b.y - a.y, b.x - a.x), head = Math.max(10, s.width * 4);
				ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(angle - .5), b.y - head * Math.sin(angle - .5)); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x - head * Math.cos(angle + .5), b.y - head * Math.sin(angle + .5)); ctx.stroke();
			}
		} else {
			ctx.beginPath(); const first = xy(s.points[0]); ctx.moveTo(first.x, first.y);
			if (s.points.length === 1) ctx.arc(first.x, first.y, Math.max(1, s.width / 2), 0, Math.PI * 2);
			else for (let i = 1; i < s.points.length; i++) { const p = xy(s.points[i]); ctx.lineTo(p.x, p.y); }
			ctx.stroke();
		}
		ctx.restore();
	}
	function redrawOverlay(pageNumber: number, canvas: HTMLCanvasElement | null) {
		if (!canvas) return;
		const ctx = canvas.getContext('2d')!;
		const r = canvas.getBoundingClientRect();
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		if (!showAnnotations) return;
		const dpr = canvas.width / Math.max(1, r.width); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
		for (const s of strokes[pageNumber] || []) drawStroke(ctx, s, canvas);
	}

	function snapshot(p: number): History { return { strokes: structuredClone(strokes[p] || []) }; }
	function checkpoint(p: number) {
		const old = histories[p] || [];
		const i = historyIndex[p] ?? -1;
		const next = [...old.slice(0, i + 1), snapshot(p)].slice(-80);
		histories = { ...histories, [p]: next }; historyIndex = { ...historyIndex, [p]: next.length - 1 };
		queueSave(p);
	}
	function restore(p: number, h: History) { strokes = { ...strokes, [p]: structuredClone(h.strokes) }; void save(p); redrawOverlay(p, canvasForPage(p)); }
	function undo() { const i = historyIndex[page] ?? 0; if (i > 0) { historyIndex = { ...historyIndex, [page]: i - 1 }; restore(page, histories[page][i - 1]); } }
	function redo() { const i = historyIndex[page] ?? 0; if (i < (histories[page]?.length || 1) - 1) { historyIndex = { ...historyIndex, [page]: i + 1 }; restore(page, histories[page][i + 1]); } }
	function queueSave(p: number) { const old = saveTimers.get(p); if (old) clearTimeout(old); saveTimers.set(p, setTimeout(() => void save(p), 180)); }
	async function save(p: number) { await db.annotations.put({ id: `${score.id}_page_${p}`, scoreId: score.id, pageNum: p, strokes: structuredClone(strokes[p] || []), stamps: [], notes: [] }); }

	function next() { const n = Math.min(pdfDoc?.numPages || page, page + (dual ? 2 : 1)); if (n !== page) { page = n; pageInput = String(n); void render(); } }
	function previous() { const n = Math.max(1, page - (dual ? 2 : 1)); if (n !== page) { page = n; pageInput = String(n); void render(); } }
	function gotoPage() { const n = Math.max(1, Math.min(pdfDoc?.numPages || 1, Number(pageInput) || 1)); page = n; pageInput = String(n); void render(); }
	function setZoom(v: number) { zoom = Math.max(.5, Math.min(2.5, v)); fit = 'free'; void render(); }
	function resetView() { zoom = 1; fit = 'page'; void render(); }
	function persist() { localStorage.setItem(prefsKey, JSON.stringify({ bookmarked, dual, zoom, showAnnotations })); settings = false; }
	function toggleBookmark() { bookmarked = !bookmarked; persist(); }
	async function downloadPdf() { const url = URL.createObjectURL(score.pdfBlob); const a = document.createElement('a'); a.href = url; a.download = `${score.title || 'score'}.pdf`; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }
	async function printPdf() { const url = URL.createObjectURL(score.pdfBlob); const frame = document.createElement('iframe'); frame.style.position = 'fixed'; frame.style.width = '1px'; frame.style.height = '1px'; frame.style.opacity = '0'; frame.src = url; document.body.appendChild(frame); frame.onload = () => { frame.contentWindow?.print(); setTimeout(() => { frame.remove(); URL.revokeObjectURL(url); }, 1000); }; }
	async function searchCurrentPage() {
		if (!pdfDoc || !searchText.trim()) { searchResult = ''; return; }
		try { const p = await pdfDoc.getPage(page); const content = await p.getTextContent(); const text = content.items.map((x: any) => x.str || '').join(' '); searchResult = text.toLowerCase().includes(searchText.trim().toLowerCase()) ? `Found on page ${page}` : 'Not found on this page'; }
		catch { searchResult = 'This PDF page has no searchable text.'; }
	}
</script>

<svelte:window onpointerup={endDraw} onpointercancel={endDraw} />

<div class="viewer" bind:this={host}>
	<header class:hide={reading || !controls}>
		<button class="icon" onclick={onClose} aria-label="Back"><ArrowLeft size={20}/></button>
		<div class="title"><strong>{score.title}</strong><span>{score.composer}</span></div>
		<div class="actions">
			<button class:active={bookmarked} class="icon" onclick={toggleBookmark} title="Bookmark">{bookmarked ? '★' : '☆'}</button>
			<button class="icon" class:active={showSearch} onclick={() => showSearch = !showSearch} title="Search"><Search size={19}/></button>
			<button class="icon" onclick={() => settings = !settings} title="Settings"><Settings2 size={19}/></button>
		</div>
	</header>
	{#if showSearch && !reading}<div class="searchbar"><Search size={17}/><input bind:value={searchText} onkeydown={(e) => e.key === 'Enter' && searchCurrentPage()} placeholder="Search current page…"/><span>{searchResult}</span></div>{/if}
	<div class="workspace"><main class="score-area">
		{#if loading}<div class="loading">Rendering page…</div>{/if}
		{#if error}<div class="error"><strong>Unable to render score</strong><span>{error}</span><button onclick={() => void render()}>Try again</button></div>{/if}
		<div class="pages" class:dual>
			{#each pages as p, i}
				<div class="page-wrap">
					<canvas bind:this={i === 0 ? leftPdf : rightPdf}></canvas>
					{#if annotationMode || showAnnotations}<canvas class="ink" bind:this={undefined} onpointerdown={(e) => beginDraw(e, p, i === 0 ? leftPdf! : rightPdf!)} onpointermove={moveDraw}></canvas>{/if}
				</div>
			{/each}
		</div>
	</main></div>
	{#if !reading && controls}<footer>
		<div class="page-controls"><button class="round" onclick={previous}><ChevronLeft size={20}/></button><input bind:value={pageInput} onkeydown={(e) => e.key === 'Enter' && gotoPage()} onblur={gotoPage}/><span>/ {pdfDoc?.numPages || '—'}</span><button class="round" onclick={next}><ChevronRight size={20}/></button></div>
		<div class="tools">
			<button class:active={tool === 'move' && !annotationMode} onclick={() => selectTool('move')} title="Move"><MousePointer2 size={18}/></button>
			<button class:active={tool === 'pen'} onclick={() => selectTool('pen')} title="Pen (P)"><PenTool size={18}/></button>
			<button class:active={tool === 'highlighter'} onclick={() => selectTool('highlighter')} title="Highlighter (H)"><Highlighter size={18}/></button>
			<button class:active={tool === 'line'} onclick={() => selectTool('line')} title="Line"><Minus size={18}/></button>
			<button class:active={tool === 'arrow'} onclick={() => selectTool('arrow')} title="Arrow">↗</button>
			<button class:active={tool === 'eraser'} onclick={() => selectTool('eraser')} title="Eraser (E)"><Eraser size={18}/></button>
			<span class="divider"></span><button onclick={undo} disabled={(historyIndex[page] ?? 0) <= 0} title="Undo"><Undo2 size={18}/></button><button onclick={redo} disabled={(historyIndex[page] ?? 0) >= (histories[page]?.length || 1) - 1} title="Redo"><Redo2 size={18}/></button>
		</div>
		<div class="view"><button onclick={() => setZoom(zoom - .1)}><ZoomOut size={18}/></button><span>{Math.round(zoom * 100)}%</span><button onclick={() => setZoom(zoom + .1)}><ZoomIn size={18}/></button><button class:active={dual} onclick={() => { dual = !dual; void render(); }} title="Two pages">Ⅱ</button><button onclick={() => { showAnnotations = !showAnnotations; for (const p of pages) redrawOverlay(p, canvasForPage(p)); }} title="Annotations">{showAnnotations ? '<Eye size={18}/>' : '<EyeOff size={18}/>'}</button></div>
	</footer>{/if}
	{#if annotationMode && !reading}<div class="annotation-bar"><div class="colors">{#each colors as c}<button class:selected={color === c} style={`background:${c}`} onclick={() => color = c}></button>{/each}</div><label>Size <input type="range" min="1" max="12" bind:value={width}/></label></div>{/if}
	{#if settings}<div class="popover"><div class="pophead"><strong>Viewer settings</strong><button class="icon" onclick={() => settings = false}><X size={17}/></button></div><label>Show annotations <input type="checkbox" bind:checked={showAnnotations}/></label><label>Two-page view <input type="checkbox" bind:checked={dual}/></label><div class="fit"><button class:active={fit === 'page'} onclick={() => { fit = 'page'; void render(); }}>Fit page</button><button class:active={fit === 'width'} onclick={() => { fit = 'width'; void render(); }}>Fit width</button><button onclick={resetView}><RotateCcw size={15}/> Reset</button></div><button class="save" onclick={persist}>Save preferences</button></div>{/if}
	<div class="utility"><button onclick={downloadPdf} title="Download PDF"><Download size={17}/></button><button onclick={printPdf} title="Print"><Printer size={17}/></button><button onclick={() => reading = !reading} title="Reading mode">{reading ? <Minimize2 size={17}/> : <Maximize2 size={17}/>}</button></div>
</div>

<style>
	:global(html), :global(body), :global(#app) { margin:0; width:100%; height:100%; overflow:hidden; }
	.viewer { width:100%; height:100%; display:flex; flex-direction:column; position:relative; overflow:hidden; background:#11110f; color:#f5f5f4; font-family:ui-sans-serif,system-ui,sans-serif; }
	header, footer { display:flex; align-items:center; gap:10px; background:#171714ee; backdrop-filter:blur(18px); z-index:10; border-color:#ffffff12; }
	header { min-height:62px; padding:0 14px; border-bottom:1px solid; } header.hide { opacity:0; transform:translateY(-100%); pointer-events:none; }
	.title { flex:1; min-width:0; display:flex; flex-direction:column; } .title strong,.title span { white-space:nowrap; overflow:hidden; text-overflow:ellipsis; } .title strong{font-size:14px}.title span{font-size:11px;color:#85857f;margin-top:2px}.actions{display:flex;gap:3px}
	.icon,.tools button,.view button,.round,.utility button { border:0; background:transparent; color:#aaa; min-width:40px;height:40px;border-radius:11px;display:grid;place-items:center;cursor:pointer; } button:hover{background:#ffffff0d;color:#fff} button.active{background:#6d4aff25;color:#b9a8ff} button:disabled{opacity:.25;cursor:default}
	.workspace{flex:1;min-height:0;display:flex;overflow:hidden}.score-area{flex:1;overflow:auto;background:#24231f;position:relative}.pages{min-width:100%;min-height:100%;width:max-content;display:flex;justify-content:center;align-items:flex-start;gap:28px;padding:32px;box-sizing:border-box}.page-wrap{position:relative;flex:none;background:#fff;box-shadow:0 12px 35px #0008}.page-wrap canvas{display:block}.page-wrap .ink{position:absolute;inset:0;z-index:2;touch-action:none}
	.loading{position:absolute;top:15px;left:50%;transform:translateX(-50%);z-index:6;background:#171714ee;padding:9px 14px;border-radius:999px;font-size:12px}.error{position:absolute;z-index:8;left:50%;top:50%;transform:translate(-50%,-50%);background:#171714f5;padding:24px;border-radius:18px;display:flex;flex-direction:column;gap:8px;text-align:center;width:min(420px,calc(100% - 32px));box-sizing:border-box}.error span{font-size:12px;color:#999}.error button,.save{border:0;background:#6d4aff;color:#fff;padding:10px 14px;border-radius:10px;font-weight:600;cursor:pointer}
	footer{min-height:66px;padding:8px 12px;border-top:1px solid;justify-content:space-between}.page-controls,.tools,.view{display:flex;align-items:center;gap:3px}.page-controls input{width:40px;height:36px;background:#0e0e0c;color:#fff;border:1px solid #ffffff12;border-radius:9px;text-align:center}.page-controls span,.view span{font-size:11px;color:#777}.divider{width:1px;height:24px;background:#ffffff12;margin:0 5px}
	.annotation-bar{position:absolute;bottom:82px;left:50%;transform:translateX(-50%);display:flex;align-items:center;gap:12px;padding:8px 12px;background:#181815ee;border:1px solid #ffffff12;border-radius:14px;z-index:12}.colors{display:flex;gap:5px}.colors button{width:22px;height:22px;border-radius:50%;border:2px solid transparent;cursor:pointer}.colors button.selected{border-color:#fff}.annotation-bar label{font-size:11px;color:#888}.searchbar{display:flex;align-items:center;gap:8px;padding:8px 14px;background:#191916;border-bottom:1px solid #ffffff10;z-index:9}.searchbar input{flex:1;background:transparent;border:0;outline:0;color:#fff}.searchbar span{font-size:11px;color:#777}.popover{position:absolute;right:16px;top:68px;width:290px;padding:16px;background:#181815f5;border:1px solid #ffffff12;border-radius:16px;z-index:20;box-shadow:0 18px 50px #0009}.pophead{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.popover label{display:flex;justify-content:space-between;align-items:center;padding:10px 0;font-size:13px}.fit{display:flex;gap:5px;margin-top:8px}.fit button{flex:1;border:0;border-radius:9px;padding:8px;background:#ffffff0a;color:#bbb;cursor:pointer}.fit button.active{background:#6d4aff30;color:#c4b5fd}.save{width:100%;margin-top:12px}.utility{position:absolute;right:14px;bottom:82px;display:flex;gap:4px;padding:4px;background:#181815ee;border:1px solid #ffffff12;border-radius:12px;z-index:11}.utility button{min-width:36px;height:36px}
	@media (max-width:800px){footer{gap:4px}.tools button:nth-of-type(4),.tools button:nth-of-type(5){display:none}.title span{display:none}.pages{padding:18px;gap:14px}.utility{bottom:76px}.annotation-bar{bottom:76px}}
</style>
