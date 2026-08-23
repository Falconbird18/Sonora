<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as pdfjsLib from 'pdfjs-dist';
	import {
		ArrowLeft,
		ChevronLeft,
		ChevronRight,
		Pencil,
		Highlighter,
		Eraser,
		Trash2,
		ZoomIn,
		ZoomOut,
		RotateCcw,
		Undo,
		Redo,
		Music2,
		Type,
		Search,
		Move,
		X,
		Check,
		Maximize2,
		Star,
		Minus,
		ArrowUpRight
	} from 'lucide-svelte';
	import { db } from './db';
	import type {
		ScoreItem,
		Stroke,
		SymbolStamp,
		TextNote,
		Point
	} from './types';
	import {
		MUSICAL_SYMBOLS,
		SYMBOL_CATEGORIES,
		type SymbolCategory
	} from './musicSymbols';

	let { score, onBack }: { score: ScoreItem; onBack: () => void } = $props();
	let pdfDoc = $state<pdfjsLib.PDFDocumentProxy | null>(null),
		currentPage = $state(1),
		totalPages = $state(score.totalPages || 0);
	let loading = $state(true),
		error = $state(''),
		progress = $state(0),
		loadingText = $state('Opening score…');
	let zoom = $state(1),
		dual = $state(false),
		readingMode = $state(false),
		showThumbs = $state(true),
		favorite = $state(!!score.favorite);
	let annotationOpen = $state(false),
		tool = $state<
			| 'pen'
			| 'highlighter'
			| 'text'
			| 'stamp'
			| 'move'
			| 'eraser'
			| 'line'
			| 'arrow'
		>('pen');
	let color = $state('#ef4444'),
		width = $state(3),
		selectedSymbol = $state(MUSICAL_SYMBOLS[0]?.symbol || ''),
		symbolCategory = $state<SymbolCategory>('Common'),
		symbolSearch = $state('');
	let annotations = $state<Record<number, Stroke[]>>({}),
		stamps = $state<Record<number, SymbolStamp[]>>({}),
		notes = $state<Record<number, TextNote[]>>({});
	let undoStack = $state<
			Record<
				number,
				{ strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[] }[]
			>
		>({}),
		redoStack = $state<
			Record<
				number,
				{ strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[] }[]
			>
		>({});
	let currentStroke = $state<Stroke | null>(null),
		drawing = $state(false);
	let drag = $state<{
			type: 'note' | 'stamp';
			id: string;
			dx: number;
			dy: number;
		} | null>(null),
		selectedId = $state<string | null>(null);
	let editing = $state<{
		page: number;
		x: number;
		y: number;
		text: string;
		color: string;
		fontSize: number;
		id?: string;
	} | null>(null);
	let leftPdf = $state<HTMLCanvasElement | null>(null),
		leftInk = $state<HTMLCanvasElement | null>(null),
		rightPdf = $state<HTMLCanvasElement | null>(null),
		rightInk = $state<HTMLCanvasElement | null>(null),
		host = $state<HTMLDivElement | null>(null);
	let thumbUrls = $state<Record<number, string>>({}),
		thumbBusy = new Set<number>(),
		renderId = 0;
	const colors = [
		'#ef4444',
		'#3b82f6',
		'#10b981',
		'#eab308',
		'#a855f7',
		'#ffffff',
		'#000000'
	];
	const filteredSymbols = $derived(
		MUSICAL_SYMBOLS.filter(
			(s) =>
				s.category === symbolCategory &&
				(!symbolSearch.trim() ||
					[s.label, ...s.keywords]
						.join(' ')
						.toLowerCase()
						.includes(symbolSearch.toLowerCase()))
		)
	);

	onMount(() => {
		dual = window.innerWidth >= 1100;
		pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
			'pdfjs-dist/build/pdf.worker.min.mjs',
			import.meta.url
		).toString();
		void openPdf();
		return () => pdfDoc?.destroy();
	});
	async function openPdf() {
		loading = true;
		error = '';
		progress = 0;
		try {
			const data = new Uint8Array(await score.pdfBlob.arrayBuffer());
			const task = pdfjsLib.getDocument({
				data,
				rangeChunkSize: 1024 * 1024,
				disableAutoFetch: true,
				disableStream: true,
				isEvalSupported: false
			});
			task.onProgress = ({ loaded, total }) => {
				progress = total
					? Math.round((loaded / total) * 100)
					: Math.min(95, progress + 5);
				loadingText = total ? `Reading score… ${progress}%` : 'Reading score…';
			};
			pdfDoc = await task.promise;
			totalPages = pdfDoc.numPages;
			const rows = await db.annotations
				.where('scoreId')
				.equals(score.id)
				.toArray();
			for (const r of rows) {
				annotations[r.pageNum] = r.strokes || [];
				stamps[r.pageNum] = r.stamps || [];
				notes[r.pageNum] = r.notes || [];
			}
			await db.scores.update(score.id, { lastOpenedAt: Date.now() });
			loading = false;
			await tick();
			await renderPages();
			await makeThumbs();
		} catch (e) {
			console.error(e);
			error = e instanceof Error ? e.message : 'The PDF could not be opened.';
			loading = false;
		}
	}
	function snapshot(p: number) {
		return {
			strokes: structuredClone(annotations[p] || []),
			stamps: structuredClone(stamps[p] || []),
			notes: structuredClone(notes[p] || [])
		};
	}
	function checkpoint(p: number) {
		(undoStack[p] ||= []).push(snapshot(p));
		if (undoStack[p].length > 60) undoStack[p].shift();
		redoStack[p] = [];
	}
	function save(p: number) {
		void db.annotations.put({
			id: `${score.id}_page_${p}`,
			scoreId: score.id,
			pageNum: p,
			strokes: annotations[p] || [],
			stamps: stamps[p] || [],
			notes: notes[p] || []
		});
	}
	function undo(p: number) {
		if (!undoStack[p]?.length) return;
		(redoStack[p] ||= []).push(snapshot(p));
		const s = undoStack[p].pop()!;
		annotations[p] = s.strokes;
		stamps[p] = s.stamps;
		notes[p] = s.notes;
		redraw(p);
		save(p);
	}
	function redo(p: number) {
		if (!redoStack[p]?.length) return;
		(undoStack[p] ||= []).push(snapshot(p));
		const s = redoStack[p].pop()!;
		annotations[p] = s.strokes;
		stamps[p] = s.stamps;
		notes[p] = s.notes;
		redraw(p);
		save(p);
	}
	function pagePoint(e: PointerEvent, c: HTMLCanvasElement): Point {
		const r = c.getBoundingClientRect();
		return {
			x: (e.clientX - r.left) / r.width,
			y: (e.clientY - r.top) / r.height,
			pressure: e.pressure || 0.5
		};
	}
	function norm(p: Point, c: HTMLCanvasElement): Point {
		return p.x > 2 || p.y > 2
			? { x: p.x / c.width, y: p.y / c.height, pressure: p.pressure }
			: p;
	}
	function xy(p: Point, c: HTMLCanvasElement) {
		const n = norm(p, c);
		return { x: n.x * c.width, y: n.y * c.height };
	}
	function drawSegment(
		ctx: CanvasRenderingContext2D,
		a: Point,
		b: Point,
		c: HTMLCanvasElement,
		s: Stroke
	) {
		const A = xy(a, c),
			B = xy(b, c);
		ctx.save();
		ctx.beginPath();
		ctx.moveTo(A.x, A.y);
		ctx.lineTo(B.x, B.y);
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.strokeStyle =
			s.tool === 'highlighter' ? 'rgba(250,204,21,.36)' : s.color;
		ctx.lineWidth =
			s.tool === 'highlighter'
				? Math.max(12, s.width * 5)
				: s.width * (a.pressure ? 0.65 + a.pressure * 0.7 : 1);
		ctx.stroke();
		ctx.restore();
	}
	function drawShape(
		ctx: CanvasRenderingContext2D,
		s: Stroke,
		c: HTMLCanvasElement
	) {
		if (s.points.length < 2) return;
		const a = xy(s.points[0], c),
			b = xy(s.points.at(-1)!, c);
		ctx.save();
		ctx.strokeStyle = s.color;
		ctx.lineWidth = s.width;
		ctx.lineCap = 'round';
		ctx.beginPath();
		ctx.moveTo(a.x, a.y);
		ctx.lineTo(b.x, b.y);
		ctx.stroke();
		if (s.kind === 'arrow') {
			const ang = Math.atan2(b.y - a.y, b.x - a.x),
				l = 13;
			ctx.beginPath();
			ctx.moveTo(b.x, b.y);
			ctx.lineTo(
				b.x - l * Math.cos(ang - 0.55),
				b.y - l * Math.sin(ang - 0.55)
			);
			ctx.moveTo(b.x, b.y);
			ctx.lineTo(
				b.x - l * Math.cos(ang + 0.55),
				b.y - l * Math.sin(ang + 0.55)
			);
			ctx.stroke();
		}
		ctx.restore();
	}
	function redraw(p: number, c: HTMLCanvasElement | null = pageCanvas(p)) {
		if (!c) return;
		const ctx = c.getContext('2d')!;
		ctx.clearRect(0, 0, c.width, c.height);
		for (const s of annotations[p] || []) {
			for (let i = 1; i < s.points.length; i++)
				drawSegment(ctx, s.points[i - 1], s.points[i], c, s);
			if (s.kind === 'line' || s.kind === 'arrow') drawShape(ctx, s, c);
		}
		for (const s of stamps[p] || []) {
			const q = xy({ x: s.x, y: s.y }, c);
			ctx.save();
			ctx.font = `${s.fontSize}px Leland,serif`;
			ctx.fillStyle = s.color;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(s.symbol, q.x, q.y);
			ctx.restore();
		}
		for (const n of notes[p] || []) {
			const q = xy({ x: n.x, y: n.y }, c);
			ctx.save();
			ctx.font = `600 ${n.fontSize}px sans-serif`;
			ctx.fillStyle = n.color;
			ctx.textBaseline = 'middle';
			ctx.fillText(n.text, q.x, q.y);
			if (selectedId === n.id) {
				const w = ctx.measureText(n.text).width;
				ctx.strokeStyle = '#60a5fa';
				ctx.setLineDash([4, 4]);
				ctx.strokeRect(q.x - 5, q.y - n.fontSize - 4, w + 10, n.fontSize + 10);
			}
			ctx.restore();
		}
	}
	function pageCanvas(p: number) {
		return p === currentPage
			? leftInk
			: dual && p === currentPage + 1
				? rightInk
				: null;
	}
	async function renderOne(
		p: number,
		pdf: HTMLCanvasElement | null,
		ink: HTMLCanvasElement | null,
		id: number
	) {
		if (!pdfDoc || !pdf || !ink || !host) return;
		const page = await pdfDoc.getPage(p);
		if (id !== renderId) return;
		const base = page.getViewport({ scale: 1 });
		const aw = dual
				? Math.max(240, (host.clientWidth - 100) / 2)
				: Math.max(240, host.clientWidth - 70),
			ah = Math.max(240, host.clientHeight - 50);
		let scale = Math.min(aw / base.width, ah / base.height) * zoom;
		const maxPixels = 10_000_000;
		if (base.width * scale * base.height * scale > maxPixels)
			scale = Math.sqrt(maxPixels / (base.width * base.height));
		scale = Math.max(0.2, Math.min(2.2, scale));
		const viewport = page.getViewport({ scale }),
			w = Math.ceil(viewport.width),
			h = Math.ceil(viewport.height);
		pdf.width = w;
		pdf.height = h;
		ink.width = w;
		ink.height = h;
		pdf.style.width = ink.style.width = `${w}px`;
		pdf.style.height = ink.style.height = `${h}px`;
		await page.render({
			canvas: pdf,
			canvasContext: pdf.getContext('2d', { alpha: false })!,
			viewport
		}).promise;
		if (id === renderId) redraw(p, ink);
	}
	async function renderPages() {
		if (!pdfDoc || !host) return;
		const id = ++renderId;
		await renderOne(currentPage, leftPdf, leftInk, id);
		if (dual && currentPage < totalPages)
			await renderOne(currentPage + 1, rightPdf, rightInk, id);
		await makeThumbs();
	}
	async function makeThumb(p = currentPage) {
		if (!pdfDoc || thumbUrls[p] || thumbBusy.has(p)) return;
		thumbBusy.add(p);
		try {
			const page = await pdfDoc.getPage(p),
				v = page.getViewport({ scale: 0.14 }),
				c = document.createElement('canvas');
			c.width = Math.ceil(v.width);
			c.height = Math.ceil(v.height);
			await page.render({ canvas: c, viewport: v }).promise;
			thumbUrls[p] = c.toDataURL('image/jpeg', 0.65);
		} finally {
			thumbBusy.delete(p);
		}
	}
	async function makeThumbs() {
		await Promise.all(
			[
				currentPage - 2,
				currentPage - 1,
				currentPage,
				currentPage + 1,
				currentPage + 2
			]
				.filter((p) => p >= 1 && p <= totalPages)
				.map(makeThumb)
		);
	}
	function go(n: number) {
		const p = Math.max(
			1,
			Math.min(totalPages, dual && n % 2 === 0 ? n - 1 : n)
		);
		if (p === currentPage) return;
		currentPage = p;
		selectedId = null;
		void renderPages();
	}
	function hitNote(p: number, q: Point) {
		for (const n of [...(notes[p] || [])].reverse()) {
			const x = n.x <= 1 ? n.x : q.x + 10,
				y = n.y <= 1 ? n.y : q.y + 10,
				w = Math.max(0.06, n.text.length * 0.012);
			if (q.x >= x - 0.02 && q.x <= x + w && Math.abs(q.y - y) < 0.045)
				return n;
		}
		return null;
	}
	function hitStamp(p: number, q: Point) {
		for (const s of [...(stamps[p] || [])].reverse()) {
			const x = s.x <= 1 ? s.x : q.x + 10,
				y = s.y <= 1 ? s.y : q.y + 10;
			if (Math.hypot(q.x - x, q.y - y) < 0.065) return s;
		}
		return null;
	}
	function start(e: PointerEvent, p: number, c: HTMLCanvasElement) {
		if (!annotationOpen) return;
		const q = pagePoint(e, c);
		selectedId = null;
		if (tool === 'move') {
			const n = hitNote(p, q),
				s = n ? null : hitStamp(p, q);
			if (n || s) {
				selectedId = (n || s)!.id;
				drag = {
					type: n ? 'note' : 'stamp',
					id: selectedId,
					dx: q.x - (n || s)!.x,
					dy: q.y - (n || s)!.y
				};
				c.setPointerCapture(e.pointerId);
			}
			return;
		}
		if (tool === 'text') {
			editing = { page: p, x: q.x, y: q.y, text: '', color, fontSize: 16 };
			return;
		}
		if (tool === 'stamp') {
			checkpoint(p);
			(stamps[p] ||= []).push({
				id: crypto.randomUUID(),
				symbol: selectedSymbol,
				label: 'symbol',
				x: q.x,
				y: q.y,
				fontSize: 34,
				color
			});
			redraw(p, c);
			save(p);
			return;
		}
		drawing = true;
		c.setPointerCapture(e.pointerId);
		if (tool === 'eraser') {
			checkpoint(p);
			erase(p, q, c);
			return;
		}
		checkpoint(p);
		currentStroke = {
			id: crypto.randomUUID(),
			tool: tool === 'highlighter' ? 'highlighter' : 'pen',
			kind: tool === 'line' || tool === 'arrow' ? tool : 'freehand',
			color,
			width,
			points: [q]
		};
		if (tool === 'line' || tool === 'arrow') redraw(p, c);
	}
	function move(e: PointerEvent, p: number, c: HTMLCanvasElement) {
		const q = pagePoint(e, c);
		if (drag) {
			const item =
				drag.type === 'note'
					? (notes[p] || []).find((n) => n.id === drag.id)
					: (stamps[p] || []).find((s) => s.id === drag.id);
			if (item) {
				item.x = q.x - drag.dx;
				item.y = q.y - drag.dy;
				redraw(p, c);
			}
			return;
		}
		if (!drawing || !currentStroke) return;
		if (tool === 'eraser') {
			erase(p, q, c);
			return;
		}
		if (currentStroke.kind === 'line' || currentStroke.kind === 'arrow') {
			currentStroke.points = [currentStroke.points[0], q];
			redraw(p, c);
			return;
		}
		const last = currentStroke.points.at(-1)!;
		if (Math.hypot(q.x - last.x, q.y - last.y) < 0.002) return;
		currentStroke.points.push(q);
		drawSegment(c.getContext('2d')!, last, q, c, currentStroke);
	}
	function end(e: PointerEvent, p: number, c: HTMLCanvasElement) {
		if (drag) {
			drag = null;
			selectedId = null;
			save(p);
			redraw(p, c);
			return;
		}
		if (!drawing) return;
		drawing = false;
		if (currentStroke) {
			(annotations[p] ||= []).push(currentStroke);
			currentStroke = null;
			redraw(p, c);
			save(p);
		}
	}
	function erase(p: number, q: Point, c: HTMLCanvasElement) {
		const r = 0.035;
		annotations[p] = (annotations[p] || []).filter(
			(s) =>
				!s.points.some((x) => {
					const n = norm(x, c);
					return Math.hypot(n.x - q.x, n.y - q.y) < r;
				})
		);
		stamps[p] = (stamps[p] || []).filter(
			(s) => Math.hypot(s.x - q.x, s.y - q.y) > r
		);
		notes[p] = (notes[p] || []).filter(
			(n) => Math.hypot(n.x - q.x, n.y - q.y) > r
		);
		redraw(p, c);
	}
	function confirmText() {
		if (!editing || !editing.text.trim()) {
			editing = null;
			return;
		}
		const e = editing;
		checkpoint(e.page);
		const old = e.id ? (notes[e.page] || []).find((n) => n.id === e.id) : null;
		if (old) {
			old.text = e.text.trim();
			old.color = e.color;
			old.fontSize = e.fontSize;
		} else {
			(notes[e.page] ||= []).push({
				id: crypto.randomUUID(),
				text: e.text.trim(),
				x: e.x,
				y: e.y,
				fontSize: e.fontSize,
				color: e.color
			});
		}
		editing = null;
		redraw(e.page);
		save(e.page);
	}
	async function toggleFavorite() {
		favorite = !favorite;
		await db.scores.update(score.id, { favorite });
	}
	function key(e: KeyboardEvent) {
		if (
			e.target instanceof HTMLInputElement ||
			e.target instanceof HTMLTextAreaElement
		)
			return;
		if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
			e.preventDefault();
			undo(currentPage);
		} else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
			e.preventDefault();
			redo(currentPage);
		} else if (e.key === 'ArrowRight' || e.key === 'PageDown')
			go(currentPage + (dual ? 2 : 1));
		else if (e.key === 'ArrowLeft' || e.key === 'PageUp')
			go(currentPage - (dual ? 2 : 1));
		else if (e.key.toLowerCase() === 'f') readingMode = !readingMode;
	}
</script>

<svelte:window onkeydown={key} />
<div class="flex-1 flex flex-col relative bg-neutral-950 text-neutral-100">
	{#if !readingMode}<header
			class="h-14 shrink-0 flex items-center justify-between px-3 border-b border-neutral-800 bg-neutral-900/95 z-30">
			<button
				onclick={onBack}
				class="p-2 rounded-xl hover:bg-neutral-800 text-neutral-400"
				><ArrowLeft size={18} /></button>
			<div class="min-w-0 text-center">
				<div class="font-semibold text-sm truncate">{score.title}</div>
				<div class="text-[11px] text-neutral-500 truncate">
					{score.composer}
				</div>
			</div>
			<div class="flex items-center">
				<button
					onclick={toggleFavorite}
					class="p-2 rounded-xl hover:bg-neutral-800"
					><Star
						size={17}
						fill={favorite ? 'currentColor' : 'none'}
						class={favorite ? 'text-yellow-400' : 'text-neutral-500'} /></button
				><button
					onclick={() => (readingMode = true)}
					class="p-2 rounded-xl hover:bg-neutral-800 text-neutral-400"
					><Maximize2 size={17} /></button>
			</div>
		</header>{/if}
	<div class="flex-1 flex min-h-0">
		<aside
			class="w-24 shrink-0 border-r border-neutral-800 bg-neutral-900/80 overflow-y-auto p-2 space-y-2 {showThumbs
				? ''
				: 'hidden'}">
			{#each [currentPage - 2, currentPage - 1, currentPage, currentPage + 1, currentPage + 2] as p}{#if p >= 1 && p <= totalPages}<button
						onclick={() => go(p)}
						class="w-full rounded-lg p-1 border {p === currentPage
							? 'border-blue-500 bg-blue-500/10'
							: 'border-neutral-800 bg-neutral-950'}"
						><img
							src={thumbUrls[p] || ''}
							alt="Page {p}"
							class="w-full aspect-[.7] object-contain" /><span
							class="text-[9px] text-neutral-500">{p}</span
						></button
					>{/if}{/each}
		</aside>
		<div
			bind:this={host}
			class="flex-1 overflow-auto flex items-center justify-center p-3 bg-neutral-950">
			{#if loading}<div class="w-72 text-center text-neutral-500">
					<div
						class="w-9 h-9 mx-auto border-2 border-neutral-700 border-t-blue-400 rounded-full animate-spin">
					</div>
					<p class="mt-3 text-sm">{loadingText}</p>
					{#if progress}<div
							class="h-1.5 mt-3 bg-neutral-800 rounded-full overflow-hidden">
							<div class="h-full bg-blue-500" style="width:{progress}%"></div>
						</div>{/if}
				</div>{:else if error}<div class="max-w-lg text-center">
					<p class="text-red-400 font-semibold">Unable to open this score</p>
					<p class="text-xs text-neutral-500 mt-2 break-words">{error}</p>
					<button
						onclick={openPdf}
						class="mt-4 px-4 py-2 rounded-xl bg-neutral-800">Try again</button>
				</div>{:else}<div class="flex gap-4 items-center">
					<div class="relative bg-white shadow-2xl">
						<canvas bind:this={leftPdf} class="block"></canvas><canvas
							bind:this={leftInk}
							class="absolute inset-0 touch-none {annotationOpen
								? 'cursor-crosshair'
								: 'pointer-events-none'}"
							onpointerdown={(e) => leftInk && start(e, currentPage, leftInk)}
							onpointermove={(e) => leftInk && move(e, currentPage, leftInk)}
							onpointerup={(e) => leftInk && end(e, currentPage, leftInk)}
							onpointercancel={(e) => leftInk && end(e, currentPage, leftInk)}
							ondblclick={(e) => {
								if (leftInk && tool === 'move') {
									const n = hitNote(currentPage, pagePoint(e, leftInk));
									if (n)
										editing = {
											page: currentPage,
											x: n.x,
											y: n.y,
											text: n.text,
											color: n.color,
											fontSize: n.fontSize,
											id: n.id
										};
								}
							}} />
					</div>
					{#if dual && currentPage < totalPages}<div
							class="relative bg-white shadow-2xl">
							<canvas bind:this={rightPdf} class="block"></canvas><canvas
								bind:this={rightInk}
								class="absolute inset-0 touch-none {annotationOpen
									? ''
									: 'pointer-events-none'}"
								onpointerdown={(e) =>
									rightInk && start(e, currentPage + 1, rightInk)}
								onpointermove={(e) =>
									rightInk && move(e, currentPage + 1, rightInk)}
								onpointerup={(e) =>
									rightInk && end(e, currentPage + 1, rightInk)}
								onpointercancel={(e) =>
									rightInk && end(e, currentPage + 1, rightInk)} />
						</div>{/if}
				</div>{/if}
		</div>
	</div>
	{#if !readingMode}<footer
			class="h-16 shrink-0 flex items-center justify-center gap-2 border-t border-neutral-800 bg-neutral-900/95 z-30">
			<button
				onclick={() => go(currentPage - (dual ? 2 : 1))}
				disabled={currentPage <= 1}
				class="p-2 rounded-xl bg-neutral-800 disabled:opacity-30"
				><ChevronLeft size={18} /></button>
			<div
				class="flex items-center gap-1 bg-neutral-950 border border-neutral-800 rounded-xl px-2">
				<input
					value={currentPage}
					oninput={e=>{const n=Number((e.currentTarget as HTMLInputElement).value);if(n>=1&&n<=totalPages)go(n)}}
					class="w-12 bg-transparent text-center text-sm outline-none" /><span
					class="text-xs text-neutral-600">/ {totalPages}</span>
			</div>
			<button
				onclick={() => go(currentPage + (dual ? 2 : 1))}
				disabled={currentPage >= totalPages}
				class="p-2 rounded-xl bg-neutral-800 disabled:opacity-30"
				><ChevronRight size={18} /></button
			><button
				onclick={() => (zoom = Math.max(0.6, zoom - 0.1))}
				class="p-2 rounded-xl bg-neutral-800"><ZoomOut size={16} /></button
			><span class="text-xs w-12 text-center">{Math.round(zoom * 100)}%</span
			><button
				onclick={() => {
					zoom = Math.min(2, zoom + 0.1);
					void renderPages();
				}}
				class="p-2 rounded-xl bg-neutral-800"><ZoomIn size={16} /></button
			><button
				onclick={() => {
					zoom = 1;
					void renderPages();
				}}
				class="p-2 rounded-xl bg-neutral-800"><RotateCcw size={15} /></button
			><button
				onclick={() => (showThumbs = !showThumbs)}
				class="px-3 py-2 rounded-xl bg-neutral-800 text-xs">Pages</button
			><button
				onclick={() => (annotationOpen = !annotationOpen)}
				class="px-3 py-2 rounded-xl text-xs font-semibold {annotationOpen
					? 'bg-blue-600'
					: 'bg-neutral-800'}"
				><Pencil size={14} class="inline mr-1" />Annotate</button>
		</footer>{/if}
	{#if annotationOpen}<div
			class="absolute {readingMode
				? 'top-3'
				: 'top-16'} left-1/2 -translate-x-1/2 z-40 w-[min(920px,calc(100vw-20px))] bg-neutral-900/95 backdrop-blur-xl border border-neutral-700 rounded-2xl p-2 shadow-2xl">
			<div class="flex items-center gap-1 overflow-x-auto">
				<button
					onclick={() => (tool = 'pen')}
					class="tool {tool === 'pen' ? 'on' : ''}"><Pencil size={17} /></button
				><button
					onclick={() => (tool = 'highlighter')}
					class="tool {tool === 'highlighter' ? 'on' : ''}"
					><Highlighter size={17} /></button
				><button
					onclick={() => (tool = 'line')}
					class="tool {tool === 'line' ? 'on' : ''}"><Minus size={17} /></button
				><button
					onclick={() => (tool = 'arrow')}
					class="tool {tool === 'arrow' ? 'on' : ''}"
					><ArrowUpRight size={17} /></button
				><button
					onclick={() => (tool = 'stamp')}
					class="tool {tool === 'stamp' ? 'on' : ''}"
					><Music2 size={17} /></button
				><button
					onclick={() => (tool = 'text')}
					class="tool {tool === 'text' ? 'on' : ''}"><Type size={17} /></button
				><button
					onclick={() => (tool = 'move')}
					class="tool {tool === 'move' ? 'on' : ''}"><Move size={17} /></button
				><button
					onclick={() => (tool = 'eraser')}
					class="tool {tool === 'eraser' ? 'on' : ''}"
					><Eraser size={17} /></button
				><span class="h-5 w-px bg-neutral-700 mx-1"></span
				>{#each colors as c}<button
						onclick={() => (color = c)}
						class="w-5 h-5 rounded-full border border-neutral-700 {color === c
							? 'ring-2 ring-blue-500'
							: ''}"
						style="background:{c}"></button
					>{/each}<span class="h-5 w-px bg-neutral-700 mx-1"></span><button
					onclick={() => undo(currentPage)}
					class="tool"><Undo size={16} /></button
				><button onclick={() => redo(currentPage)} class="tool"
					><Redo size={16} /></button
				><button
					onclick={() => {
						checkpoint(currentPage);
						annotations[currentPage] = [];
						stamps[currentPage] = [];
						notes[currentPage] = [];
						redraw(currentPage);
						save(currentPage);
					}}
					class="tool text-red-300"><Trash2 size={16} /></button>
			</div>
			{#if tool === 'stamp'}<div
					class="mt-2 pt-2 border-t border-neutral-800 space-y-2">
					<div class="relative">
						<Search
							size={14}
							class="absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500" /><input
							bind:value={symbolSearch}
							placeholder="Search musical symbols…"
							class="w-full bg-neutral-950 border border-neutral-800 rounded-lg pl-7 pr-2 py-1.5 text-xs" />
					</div>
					<div class="flex gap-1 overflow-x-auto">
						{#each SYMBOL_CATEGORIES as cat}<button
								onclick={() => (symbolCategory = cat)}
								class="px-2.5 py-1 rounded-lg text-[10px] whitespace-nowrap {symbolCategory ===
								cat
									? 'bg-purple-600/25 text-purple-200 border border-purple-500/50'
									: 'bg-neutral-950 text-neutral-500 border border-neutral-800'}"
								>{cat}</button
							>{/each}
					</div>
					<div
						class="grid grid-cols-6 sm:grid-cols-10 max-h-28 overflow-y-auto gap-1">
						{#each filteredSymbols as s}<button
								onclick={() => (selectedSymbol = s.symbol)}
								title={s.label}
								class="aspect-square rounded-lg border {selectedSymbol ===
								s.symbol
									? 'border-purple-500 bg-purple-500/15'
									: 'border-neutral-800 bg-neutral-950'}"
								><span class="text-2xl" style="font-family:Leland,serif"
									>{s.symbol}</span
								></button
							>{/each}
					</div>
				</div>{/if}
			<div class="text-[10px] text-neutral-500 px-1 pt-1">
				Stylus pressure changes pen weight. Move repositions text and symbols;
				double-click a note to edit it.
			</div>
		</div>{/if}
	{#if editing}<div
			class="absolute inset-0 z-50 flex items-center justify-center bg-black/50">
			<div
				class="w-[min(440px,calc(100vw-28px))] bg-neutral-900 border border-neutral-700 rounded-2xl p-4 shadow-2xl">
				<div class="flex justify-between items-center mb-3">
					<h3 class="font-semibold">
						{editing.id ? 'Edit rehearsal note' : 'Add rehearsal note'}
					</h3>
					<button onclick={() => (editing = null)}><X size={18} /></button>
				</div>
				<textarea
					autofocus
					bind:value={editing.text}
					rows="4"
					placeholder="e.g. More bow here…"
					class="w-full bg-neutral-950 border border-neutral-800 rounded-xl p-3 text-sm resize-none outline-none focus:border-blue-500"
				></textarea>
				<div class="flex justify-end gap-2 mt-3">
					<button
						onclick={() => (editing = null)}
						class="px-3 py-2 text-sm text-neutral-400">Cancel</button
					><button
						onclick={confirmText}
						class="px-4 py-2 rounded-xl bg-blue-600 text-sm"
						><Check size={15} class="inline mr-1" />Save</button>
				</div>
			</div>
		</div>{/if}
</div>

<style>
	@font-face {
		font-family: Leland;
		src:
			url('/fonts/Leland.woff2') format('woff2'),
			url('/fonts/Leland.woff') format('woff'),
			url('/fonts/Leland.otf') format('opentype');
		font-display: swap;
	}
	.tool {
		padding: 0.5rem;
		border-radius: 0.75rem;
		color: #a3a3a3;
	}
	.tool:hover {
		background: #262626;
		color: white;
	}
	.tool.on {
		background: #2563eb;
		color: white;
	}
</style>
