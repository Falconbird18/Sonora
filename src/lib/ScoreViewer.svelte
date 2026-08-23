<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as pdfjsLib from 'pdfjs-dist';
	import { db } from './db';
	import type { ScoreItem, Stroke, Point } from './types';
	import {
		ArrowLeft,
		ChevronLeft,
		ChevronRight,
		Download,
		Eraser,
		Eye,
		EyeOff,
		Highlighter,
		Maximize2,
		Minimize2,
		Minus,
		MousePointer2,
		PenTool,
		Printer,
		Redo2,
		RotateCcw,
		Search,
		Settings2,
		Undo2,
		X,
		ZoomIn,
		ZoomOut
	} from 'lucide-svelte';
	let { score, onClose }: { score: ScoreItem; onClose: () => void } = $props();
	type Tool = 'move' | 'pen' | 'highlighter' | 'eraser' | 'line' | 'arrow';
	type Fit = 'page' | 'width' | 'free';
	type Snap = { strokes: Stroke[] };
	class BlobRangeTransport extends pdfjsLib.PDFDataRangeTransport {
		private blob: Blob;
		private pending = new Map<string, Promise<void>>();
		constructor(blob: Blob) {
			super(blob.size, null, false, 'score.pdf');
			this.blob = blob;
		}
		requestDataRange(a: number, b: number) {
			const k = `${a}:${b}`;
			if (this.pending.has(k)) return;
			const p = this.blob
				.slice(a, b)
				.arrayBuffer()
				.then((x) => {
					this.onDataRange(a, new Uint8Array(x));
					this.onDataProgress(Math.min(b, this.blob.size));
				})
				.catch((e) => this.abort(e));
			this.pending.set(k, p);
			void p.finally(() => this.pending.delete(k));
		}
		abort(_?: unknown) {
			this.pending.clear();
		}
	}
	let pdf = $state<pdfjsLib.PDFDocumentProxy | null>(null),
		transport: BlobRangeTransport | null = null;
	let page = $state(1),
		pageInput = $state('1'),
		zoom = $state(1),
		fit = $state<Fit>('page'),
		dual = $state(false),
		reading = $state(false),
		controls = $state(true);
	let loading = $state(false),
		error = $state(''),
		searchOpen = $state(false),
		searchText = $state(''),
		searchStatus = $state(''),
		settingsOpen = $state(false),
		bookmarked = $state(false);
	let annotationOpen = $state(false),
		visible = $state(true),
		tool = $state<Tool>('move'),
		color = $state('#ef4444'),
		width = $state(3);
	let strokes = $state<Record<number, Stroke[]>>({}),
		history = $state<Record<number, Snap[]>>({}),
		historyIndex = $state<Record<number, number>>({});
	let host = $state<HTMLElement | null>(null),
		leftPdf = $state<HTMLCanvasElement | null>(null),
		rightPdf = $state<HTMLCanvasElement | null>(null),
		leftInk = $state<HTMLCanvasElement | null>(null),
		rightInk = $state<HTMLCanvasElement | null>(null);
	let generation = 0,
		tasks: pdfjsLib.RenderTask[] = [];
	let resizeTimer: ReturnType<typeof setTimeout> | undefined;
	let saveTimers = new Map<number, ReturnType<typeof setTimeout>>();
	let drawing: {
		page: number;
		canvas: HTMLCanvasElement;
		stroke?: Stroke;
		pointerId: number;
		raf?: number;
	} | null = null;
	const colors = [
			'#ef4444',
			'#2563eb',
			'#16a34a',
			'#eab308',
			'#9333ea',
			'#111827'
		],
		maxPixels = 7500000,
		prefs = `sonora-viewer-${score.id}`;
	const pages = $derived(
		dual
			? [
					Math.max(1, page % 2 === 0 ? page : page - 1),
					Math.min(pdf?.numPages ?? 1, (page % 2 === 0 ? page : page - 1) + 1)
				]
			: [page]
	);
	const currentHistory = $derived(history[page] || []),
		currentHistoryIndex = $derived(historyIndex[page] ?? 0);

	onMount(() => {
		try {
			const s = JSON.parse(localStorage.getItem(prefs) || '{}');
			bookmarked = !!s.bookmarked;
			dual = !!s.dual;
			zoom = typeof s.zoom === 'number' ? s.zoom : 1;
			visible = s.visible !== false;
		} catch {}
		void load();
		const key = (e: KeyboardEvent) => {
			if (
				e.target instanceof HTMLInputElement ||
				e.target instanceof HTMLTextAreaElement
			)
				return;
			if (e.key === 'ArrowRight') next();
			else if (e.key === 'ArrowLeft') previous();
			else if (e.key === '+' || e.key === '=') setZoom(zoom + 0.1);
			else if (e.key === '-') setZoom(zoom - 0.1);
			else if (e.key.toLowerCase() === 'p') choose('pen');
			else if (e.key.toLowerCase() === 'h') choose('highlighter');
			else if (e.key.toLowerCase() === 'e') choose('eraser');
			else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
				e.preventDefault();
				undo();
			} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
				e.preventDefault();
				redo();
			} else if (e.key === 'Escape') {
				settingsOpen = false;
				searchOpen = false;
			}
		};
		window.addEventListener('keydown', key);
		const ro = new ResizeObserver(() => {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => void render(), 120);
		});
		if (host) ro.observe(host);
		return () => {
			window.removeEventListener('keydown', key);
			ro.disconnect();
			clearTimeout(resizeTimer);
			cancel();
			for (const t of saveTimers.values()) clearTimeout(t);
			transport?.abort();
			void pdf?.destroy();
		};
	});
	async function load() {
		loading = true;
		try {
			transport = new BlobRangeTransport(score.pdfBlob);
			pdf = await pdfjsLib.getDocument({
				range: transport,
				rangeChunkSize: 524288,
				disableStream: true,
				disableAutoFetch: true,
				isEvalSupported: false
			}).promise;
			for (const r of await db.annotations
				.where('scoreId')
				.equals(score.id)
				.toArray()) {
				strokes[r.pageNum] = r.strokes || [];
				history[r.pageNum] = [{ strokes: structuredClone(r.strokes || []) }];
				historyIndex[r.pageNum] = 0;
			}
			await tick();
			await render();
		} catch (e) {
			console.error(e);
			error =
				'Sonora could not open this PDF. Try reopening or re-importing the score.';
		} finally {
			loading = false;
		}
	}
	function cancel() {
		for (const t of tasks) {
			try {
				t.cancel();
			} catch {}
		}
		tasks = [];
	}
	async function render() {
		if (!pdf || !host) return;
		cancel();
		const g = ++generation;
		loading = true;
		error = '';
		try {
			if (dual && host.clientWidth < 780) dual = false;
			await Promise.all(pages.map((p, i) => renderPage(p, i, g)));
		} catch (e) {
			if (
				!(e instanceof Error && e.name === 'RenderingCancelledException') &&
				g === generation
			)
				error =
					'The page could not be rendered at this size. Try Fit Page or reduce zoom.';
		} finally {
			if (g === generation) loading = false;
		}
	}
	async function renderPage(n: number, i: number, g: number) {
		if (!pdf || !host) return;
		const p = await pdf.getPage(n);
		if (g !== generation) return;
		const base = p.getViewport({ scale: 1 }),
			wAvail = Math.max(
				260,
				dual ? (host.clientWidth - 88) / 2 : host.clientWidth - 64
			),
			hAvail = Math.max(260, host.clientHeight - 64);
		let s =
			(fit === 'width'
				? wAvail / base.width
				: Math.min(wAvail / base.width, hAvail / base.height)) * zoom;
		if (base.width * s * base.height * s > maxPixels)
			s = Math.sqrt(maxPixels / (base.width * base.height));
		s = Math.max(0.2, Math.min(3, s));
		const v = p.getViewport({ scale: s }),
			d = Math.min(devicePixelRatio || 1, 2),
			w = Math.ceil(v.width),
			h = Math.ceil(v.height);
		const pc = i ? rightPdf : leftPdf,
			ic = i ? rightInk : leftInk;
		if (!pc || !ic) return;
		for (const c of [pc, ic]) {
			c.width = Math.ceil(w * d);
			c.height = Math.ceil(h * d);
			c.style.width = `${w}px`;
			c.style.height = `${h}px`;
		}
		const ctx = pc.getContext('2d', { alpha: false })!;
		ctx.setTransform(d, 0, 0, d, 0, 0);
		ctx.fillStyle = '#fff';
		ctx.fillRect(0, 0, w, h);
		const task = p.render({ canvasContext: ctx, viewport: v });
		tasks.push(task);
		await task.promise;
		if (g === generation) redraw(n, ic);
	}
	function pos(e: PointerEvent, c: HTMLCanvasElement): Point {
		const r = c.getBoundingClientRect();
		return {
			x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
			y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
			pressure: e.pressure || 0.5
		};
	}
	function xy(p: Point, c: HTMLCanvasElement) {
		const r = c.getBoundingClientRect();
		return { x: p.x * r.width, y: p.y * r.height };
	}
	function choose(t: Tool) {
		tool = t;
		annotationOpen = t !== 'move';
	}
	function begin(e: PointerEvent, n: number, c: HTMLCanvasElement) {
		if (!annotationOpen || tool === 'move' || reading) return;
		e.preventDefault();
		c.setPointerCapture(e.pointerId);
		const p = pos(e, c);
		if (tool === 'eraser') {
			drawing = { page: n, canvas: c, pointerId: e.pointerId };
			erase(p, n, c, false);
			return;
		}
		const s: Stroke = {
			id: crypto.randomUUID(),
			tool: tool === 'highlighter' ? 'highlighter' : 'pen',
			kind: tool === 'line' ? 'line' : tool === 'arrow' ? 'arrow' : 'freehand',
			color,
			width,
			points: [p]
		};
		strokes[n] = [...(strokes[n] || []), s];
		drawing = { page: n, canvas: c, pointerId: e.pointerId, stroke: s };
		redraw(n, c);
	}
	function move(e: PointerEvent) {
		if (!drawing) return;
		for (const ev of e.getCoalescedEvents?.() || [e]) {
			if (drawing.stroke) {
				const s = (strokes[drawing.page] || []).find(
					(x) => x.id === drawing!.stroke!.id
				);
				if (s) s.points.push(pos(ev, drawing.canvas));
			} else
				erase(pos(ev, drawing.canvas), drawing.page, drawing.canvas, false);
		}
		if (!drawing.raf)
			drawing.raf = requestAnimationFrame(() => {
				if (drawing) redraw(drawing.page, drawing.canvas);
				if (drawing) drawing.raf = undefined;
			});
	}
	function end() {
		if (!drawing) return;
		const d = drawing;
		if (d.raf) cancelAnimationFrame(d.raf);
		drawing = null;
		try {
			d.canvas.releasePointerCapture(d.pointerId);
		} catch {}
		redraw(d.page, d.canvas);
		checkpoint(d.page);
	}
	function erase(
		p: Point,
		n: number,
		c: HTMLCanvasElement | null,
		save = true
	) {
		const r = Math.max(0.006, width / 900),
			a = strokes[n] || [],
			b = a.filter(
				(s) => !s.points.some((q) => Math.hypot(q.x - p.x, q.y - p.y) < r)
			);
		if (b.length !== a.length) {
			strokes[n] = b;
			if (c) redraw(n, c);
			if (save) checkpoint(n);
		}
	}
	function redraw(n: number, c: HTMLCanvasElement | null) {
		if (!c) return;
		const ctx = c.getContext('2d')!,
			r = c.getBoundingClientRect(),
			d = c.width / Math.max(1, r.width);
		ctx.setTransform(1, 0, 0, 1, 0, 0);
		ctx.clearRect(0, 0, c.width, c.height);
		if (!visible) return;
		ctx.setTransform(d, 0, 0, d, 0, 0);
		for (const s of strokes[n] || []) drawStroke(ctx, s, c);
	}
	function drawStroke(
		ctx: CanvasRenderingContext2D,
		s: Stroke,
		c: HTMLCanvasElement
	) {
		if (!s.points.length) return;
		ctx.save();
		ctx.strokeStyle = s.color;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth =
			s.tool === 'highlighter' ? Math.max(12, s.width * 5) : s.width;
		if (s.tool === 'highlighter') {
			ctx.globalAlpha = 0.35;
			ctx.globalCompositeOperation = 'multiply';
		}
		const a = xy(s.points[0], c),
			b = xy(s.points[s.points.length - 1], c);
		ctx.beginPath();
		if (s.kind === 'line' || s.kind === 'arrow') {
			ctx.moveTo(a.x, a.y);
			ctx.lineTo(b.x, b.y);
			ctx.stroke();
			if (s.kind === 'arrow') {
				const q = Math.atan2(b.y - a.y, b.x - a.x),
					h = Math.max(10, s.width * 4);
				ctx.beginPath();
				ctx.moveTo(b.x, b.y);
				ctx.lineTo(b.x - h * Math.cos(q - 0.5), b.y - h * Math.sin(q - 0.5));
				ctx.moveTo(b.x, b.y);
				ctx.lineTo(b.x - h * Math.cos(q + 0.5), b.y - h * Math.sin(q + 0.5));
				ctx.stroke();
			}
		} else {
			ctx.moveTo(a.x, a.y);
			if (s.points.length === 1)
				ctx.arc(a.x, a.y, Math.max(1, s.width / 2), 0, Math.PI * 2);
			else
				for (let i = 1; i < s.points.length; i++) {
					const p = xy(s.points[i], c);
					ctx.lineTo(p.x, p.y);
				}
			ctx.stroke();
		}
		ctx.restore();
	}
	function snap(n: number): Snap {
		return { strokes: structuredClone(strokes[n] || []) };
	}
	function checkpoint(n: number) {
		const a = history[n] || [],
			i = historyIndex[n] ?? -1,
			h = [...a.slice(0, i + 1), snap(n)].slice(-100);
		history[n] = h;
		historyIndex[n] = h.length - 1;
		queueSave(n);
	}
	function queueSave(n: number) {
		const old = saveTimers.get(n);
		if (old) clearTimeout(old);
		saveTimers.set(
			n,
			setTimeout(() => void save(n), 220)
		);
	}
	async function save(n: number) {
		await db.annotations.put({
			id: `${score.id}_page_${n}`,
			scoreId: score.id,
			pageNum: n,
			strokes: structuredClone(strokes[n] || []),
			stamps: [],
			notes: []
		});
	}
	function restore(n: number, s: Snap) {
		strokes[n] = structuredClone(s.strokes);
		void save(n);
		redraw(n, n === pages[0] ? leftInk : rightInk);
	}
	function undo() {
		const i = historyIndex[page] ?? 0;
		if (i > 0) {
			historyIndex[page] = i - 1;
			restore(page, history[page][i - 1]);
		}
	}
	function redo() {
		const i = historyIndex[page] ?? 0;
		if (i < (history[page]?.length || 1) - 1) {
			historyIndex[page] = i + 1;
			restore(page, history[page][i + 1]);
		}
	}
	function next() {
		const n = Math.min(pdf?.numPages || page, page + (dual ? 2 : 1));
		if (n !== page) {
			page = n;
			pageInput = String(n);
			void render();
		}
	}
	function previous() {
		const n = Math.max(1, page - (dual ? 2 : 1));
		if (n !== page) {
			page = n;
			pageInput = String(n);
			void render();
		}
	}
	function gotoPage() {
		const n = Math.max(1, Math.min(pdf?.numPages || 1, Number(pageInput) || 1));
		page = n;
		pageInput = String(n);
		void render();
	}
	function setZoom(v: number) {
		zoom = Math.max(0.5, Math.min(2.5, v));
		fit = 'free';
		void render();
	}
	function reset() {
		zoom = 1;
		fit = 'page';
		void render();
	}
	function prefsSave() {
		localStorage.setItem(
			prefs,
			JSON.stringify({ bookmarked, dual, zoom, visible })
		);
		settingsOpen = false;
	}
	function bookmark() {
		bookmarked = !bookmarked;
		prefsSave();
	}
	function toggleVisible() {
		visible = !visible;
		for (const n of pages) redraw(n, n === pages[0] ? leftInk : rightInk);
	}
	function download() {
		const u = URL.createObjectURL(score.pdfBlob),
			a = document.createElement('a');
		a.href = u;
		a.download = `${score.title || 'score'}.pdf`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(u), 1000);
	}
	function print() {
		const u = URL.createObjectURL(score.pdfBlob),
			f = document.createElement('iframe');
		f.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;border:0';
		f.src = u;
		document.body.appendChild(f);
		f.onload = () => {
			f.contentWindow?.print();
			setTimeout(() => {
				f.remove();
				URL.revokeObjectURL(u);
			}, 1000);
		};
	}
	async function search() {
		if (!pdf || !searchText.trim()) {
			searchStatus = '';
			return;
		}
		try {
			const p = await pdf.getPage(page),
				c = await p.getTextContent(),
				text = c.items.map((x) => ('str' in x ? x.str : '')).join(' ');
			searchStatus = text
				.toLowerCase()
				.includes(searchText.trim().toLowerCase())
				? `Found on page ${page}`
				: `Not found on page ${page}`;
		} catch {
			searchStatus = 'This page has no searchable text.';
		}
	}
</script>

<svelte:window onpointerup={end} onpointercancel={end} />
<div class="viewer" bind:this={host}>
	<header class:hide={reading || !controls}>
		<button class="icon" onclick={onClose} aria-label="Back"
			><ArrowLeft size={20} /></button>
		<div class="title">
			<strong>{score.title}</strong><span>{score.composer}</span>
		</div>
		<div class="actions">
			<button
				class="icon"
				class:active={bookmarked}
				onclick={bookmark}
				title="Bookmark"
				>{#if bookmarked}★{:else}☆{/if}</button
			><button
				class="icon"
				class:active={searchOpen}
				onclick={() => (searchOpen = !searchOpen)}
				title="Search"><Search size={19} /></button
			><button
				class="icon"
				onclick={() => (settingsOpen = !settingsOpen)}
				title="Settings"><Settings2 size={19} /></button>
		</div>
	</header>
	{#if searchOpen && !reading}<div class="searchbar">
			<Search size={16} /><input
				bind:value={searchText}
				onkeydown={(e) => e.key === 'Enter' && search()}
				placeholder="Search current page…" /><span>{searchStatus}</span>
		</div>{/if}
	<main class="workspace">
		<section class="score-area">
			{#if loading}<div class="loading">
					Rendering score…
				</div>{/if}{#if error}<div class="error">
					<strong>Rendering failed</strong><span>{error}</span><button
						onclick={() => void render()}>Try again</button>
				</div>{/if}
			<div class="pages" class:dual>
				<div class="page-wrap">
					<canvas bind:this={leftPdf}></canvas><canvas
						class="ink"
						bind:this={leftInk}
						onpointerdown={e=>begin(e,pages[0],leftInk!)}
						onpointermove={move}></canvas>
				</div>
				{#if dual && pages[1] <= (pdf?.numPages || 0)}<div class="page-wrap">
						<canvas bind:this={rightPdf}></canvas><canvas
							class="ink"
							bind:this={rightInk}
							onpointerdown={e=>begin(e,pages[1],rightInk!)}
							onpointermove={move}></canvas>
					</div>{/if}
			</div>
		</section>
	</main>
	{#if !reading && controls}<footer>
			<div class="page">
				<button class="round" onclick={previous}
					><ChevronLeft size={20} /></button
				><input
					bind:value={pageInput}
					onkeydown={(e) => e.key === 'Enter' && gotoPage()}
					onblur={gotoPage} /><span>/ {pdf?.numPages || '—'}</span><button
					class="round"
					onclick={next}><ChevronRight size={20} /></button>
			</div>
			<div class="tools">
				<button
					class:active={tool === 'move' && !annotationOpen}
					onclick={() => choose('move')}><MousePointer2 size={18} /></button
				><button
					class:active={tool === 'pen'}
					onclick={() => choose('pen')}
					title="Pen (P)"><PenTool size={18} /></button
				><button
					class:active={tool === 'highlighter'}
					onclick={() => choose('highlighter')}
					title="Highlighter (H)"><Highlighter size={18} /></button
				><button class:active={tool === 'line'} onclick={() => choose('line')}
					><Minus size={18} /></button
				><button class:active={tool === 'arrow'} onclick={() => choose('arrow')}
					>↗</button
				><button
					class:active={tool === 'eraser'}
					onclick={() => choose('eraser')}
					title="Eraser (E)"><Eraser size={18} /></button
				><span class="divider"></span><button
					onclick={undo}
					disabled={currentHistoryIndex <= 0}><Undo2 size={18} /></button
				><button
					onclick={redo}
					disabled={currentHistoryIndex >= currentHistory.length - 1}
					><Redo2 size={18} /></button>
			</div>
			<div class="view">
				<button onclick={() => setZoom(zoom - 0.1)}
					><ZoomOut size={18} /></button
				><span>{Math.round(zoom * 100)}%</span><button
					onclick={() => setZoom(zoom + 0.1)}><ZoomIn size={18} /></button
				><button
					class:active={dual}
					onclick={() => {
						dual = !dual;
						void render();
					}}>Ⅱ</button
				><button class:active={!visible} onclick={toggleVisible}
					>{#if visible}<Eye size={18} />{:else}<EyeOff
							size={18} />{/if}</button>
			</div>
		</footer>{/if}
	{#if annotationOpen && !reading}<div class="annotation">
			<div class="colors">
				{#each colors as c}<button
						class:selected={color === c}
						style={`--c:${c}`}
						onclick={() => (color = c)}></button
					>{/each}
			</div>
			<label
				>Size <input type="range" min="1" max="12" bind:value={width} /></label>
		</div>{/if}
	{#if settingsOpen}<div class="popover">
			<div class="pophead">
				<strong>Viewer settings</strong><button
					class="icon"
					onclick={() => (settingsOpen = false)}><X size={17} /></button>
			</div>
			<label
				>Show annotations <input
					type="checkbox"
					bind:checked={visible} /></label
			><label
				>Two-page view <input type="checkbox" bind:checked={dual} /></label>
			<div class="fit">
				<button
					class:active={fit === 'page'}
					onclick={() => {
						fit = 'page';
						void render();
					}}>Fit page</button
				><button
					class:active={fit === 'width'}
					onclick={() => {
						fit = 'width';
						void render();
					}}>Fit width</button
				><button onclick={reset}><RotateCcw size={14} /> Reset</button>
			</div>
			<button class="save" onclick={prefsSave}>Save preferences</button>
		</div>{/if}
	<div class="utility">
		<button onclick={download} title="Download"><Download size={17} /></button
		><button onclick={print} title="Print"><Printer size={17} /></button><button
			onclick={() => (reading = !reading)}
			title="Reading mode"
			>{#if reading}<Minimize2 size={17} />{:else}<Maximize2
					size={17} />{/if}</button>
	</div>
</div>

<style>
	:global(html),
	:global(body),
	:global(#app) {
		margin: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
	}
	.viewer {
		height: 100%;
		width: 100%;
		display: flex;
		flex-direction: column;
		position: relative;
		overflow: hidden;
		background: #11110f;
		color: #f5f5f4;
		font-family: ui-sans-serif, system-ui, sans-serif;
	}
	header,
	footer {
		display: flex;
		align-items: center;
		gap: 10px;
		background: #171714ee;
		backdrop-filter: blur(18px);
		z-index: 10;
		border-color: #ffffff12;
	}
	header {
		min-height: 62px;
		padding: 0 14px;
		border-bottom: 1px solid;
	}
	header.hide {
		opacity: 0;
		transform: translateY(-100%);
		pointer-events: none;
	}
	.title {
		flex: 1;
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.title strong,
	.title span {
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.title strong {
		font-size: 14px;
	}
	.title span {
		font-size: 11px;
		color: #85857f;
		margin-top: 2px;
	}
	.actions,
	.page,
	.tools,
	.view {
		display: flex;
		align-items: center;
		gap: 3px;
	}
	.icon,
	.tools button,
	.view button,
	.round,
	.utility button {
		border: 0;
		background: transparent;
		color: #aaa;
		min-width: 40px;
		height: 40px;
		border-radius: 11px;
		display: grid;
		place-items: center;
		cursor: pointer;
	}
	.icon:hover,
	.tools button:hover,
	.view button:hover,
	.round:hover,
	.utility button:hover {
		background: #ffffff0d;
		color: #fff;
	}
	.active {
		background: #6d4aff25 !important;
		color: #c4b5fd !important;
	}
	button:disabled {
		opacity: 0.25;
	}
	.workspace {
		flex: 1;
		min-height: 0;
		display: flex;
		overflow: hidden;
	}
	.score-area {
		flex: 1;
		overflow: auto;
		background: #24231f;
		position: relative;
	}
	.pages {
		min-width: 100%;
		min-height: 100%;
		width: max-content;
		display: flex;
		justify-content: center;
		align-items: flex-start;
		gap: 28px;
		padding: 32px;
		box-sizing: border-box;
	}
	.page-wrap {
		position: relative;
		flex: none;
		background: #fff;
		box-shadow: 0 12px 35px #0008;
		overflow: hidden;
	}
	.page-wrap canvas {
		display: block;
	}
	.page-wrap .ink {
		position: absolute;
		inset: 0;
		z-index: 2;
		touch-action: none;
	}
	footer {
		min-height: 66px;
		padding: 8px 12px;
		border-top: 1px solid;
		justify-content: space-between;
	}
	.page input {
		width: 40px;
		height: 36px;
		background: #0e0e0c;
		color: #fff;
		border: 1px solid #ffffff12;
		border-radius: 9px;
		text-align: center;
	}
	.page span,
	.view span {
		font-size: 11px;
		color: #777;
	}
	.divider {
		width: 1px;
		height: 24px;
		background: #ffffff12;
		margin: 0 5px;
	}
	.loading {
		position: absolute;
		top: 14px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 6;
		background: #171714ee;
		padding: 9px 14px;
		border-radius: 999px;
		font-size: 12px;
	}
	.error {
		position: absolute;
		z-index: 8;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		background: #171714f5;
		padding: 24px;
		border-radius: 18px;
		display: flex;
		flex-direction: column;
		gap: 8px;
		text-align: center;
		width: min(420px, calc(100% - 32px));
		box-sizing: border-box;
	}
	.error span {
		font-size: 12px;
		color: #999;
	}
	.error button,
	.save {
		border: 0;
		background: #6d4aff;
		color: #fff;
		padding: 10px 14px;
		border-radius: 10px;
		font-weight: 600;
		cursor: pointer;
	}
	.annotation {
		position: absolute;
		bottom: 82px;
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 8px 12px;
		background: #181815ee;
		border: 1px solid #ffffff12;
		border-radius: 14px;
		z-index: 12;
	}
	.colors {
		display: flex;
		gap: 5px;
	}
	.colors button {
		width: 22px;
		height: 22px;
		border-radius: 50%;
		border: 2px solid transparent;
		background: var(--c);
		cursor: pointer;
	}
	.colors button.selected {
		border-color: #fff;
	}
	.annotation label {
		font-size: 11px;
		color: #888;
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.searchbar {
		position: absolute;
		top: 72px;
		left: 50%;
		transform: translateX(-50%);
		z-index: 20;
		width: min(520px, calc(100vw - 28px));
		height: 42px;
		border: 1px solid #ffffff12;
		border-radius: 13px;
		background: #181815f5;
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 12px;
		box-shadow: 0 12px 35px #0008;
	}
	.searchbar input {
		flex: 1;
		background: transparent;
		border: 0;
		outline: 0;
		color: #fff;
		font-size: 12px;
	}
	.searchbar span {
		font-size: 9px;
		color: #777;
	}
	.popover {
		position: absolute;
		right: 14px;
		top: 72px;
		width: 290px;
		padding: 15px;
		background: #181815f7;
		border: 1px solid #ffffff12;
		border-radius: 16px;
		z-index: 30;
		box-shadow: 0 20px 60px #0009;
	}
	.pophead {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 8px;
	}
	.popover label {
		display: flex;
		justify-content: space-between;
		padding: 11px 2px;
		border-bottom: 1px solid #ffffff09;
		font-size: 12px;
		color: #bbb;
	}
	.fit {
		display: flex;
		gap: 5px;
		margin-top: 12px;
	}
	.fit button {
		flex: 1;
		border: 0;
		border-radius: 9px;
		padding: 8px;
		background: #ffffff0a;
		color: #aaa;
		cursor: pointer;
		display: flex;
		align-items: center;
		justify-content: center;
		gap: 4px;
		font-size: 10px;
	}
	.fit button.active {
		background: #6d4aff25;
		color: #c4b5fd;
	}
	.save {
		width: 100%;
		margin-top: 12px;
	}
	.utility {
		position: absolute;
		right: 14px;
		bottom: 82px;
		display: flex;
		gap: 3px;
		padding: 4px;
		background: #181815ee;
		border: 1px solid #ffffff12;
		border-radius: 12px;
		z-index: 11;
	}
	.utility button {
		min-width: 36px;
		height: 36px;
	}
	@media (max-width: 800px) {
		footer {
			min-height: 60px;
			flex-wrap: wrap;
		}
		.tools {
			order: 3;
			width: 100%;
			overflow-x: auto;
		}
		.view {
			display: none;
		}
		.pages {
			padding: 18px 10px;
			gap: 12px;
		}
		.annotation,
		.utility {
			bottom: 126px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		* {
			transition: none !important;
			animation: none !important;
		}
	}
</style>
