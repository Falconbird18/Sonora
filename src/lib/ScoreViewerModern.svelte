<script lang="ts">
	import { onMount, tick } from 'svelte';
	import * as pdfjsLib from 'pdfjs-dist';
	import { db } from './db';
	import type { ScoreItem, Stroke, AnnotationStamp, Note } from './types';
	import {
		ChevronLeft,
		ChevronRight,
		ArrowLeft,
		PenTool,
		Highlighter,
		Eraser,
		Type,
		Undo2,
		ZoomIn,
		ZoomOut,
		MousePointer2,
		Minus,
		BookOpen
	} from 'lucide-svelte';

	let { score, onClose }: { score: ScoreItem; onClose: () => void } = $props();

	type Tool =
		| 'move'
		| 'pen'
		| 'highlighter'
		| 'eraser'
		| 'text'
		| 'line'
		| 'arrow'
		| 'sharp'
		| 'flat'
		| 'natural';

	// State
	let pdfDoc = $state<pdfjsLib.PDFDocumentProxy | null>(null);
	let current = $state(1);
	let dual = $state(false);
	let zoom = $state(1);
	let tool = $state<Tool>('move');
	let color = $state('#ef4444');
	let strokeWidth = $state(3);
	let annotations = $state<Record<number, Stroke[]>>({});
	let stamps = $state<Record<number, AnnotationStamp[]>>({});
	let notes = $state<Record<number, Note[]>>({});
	let annotationOpen = $state(false);
	let readingMode = $state(false);

	// History state
	let history = $state<
		Record<
			number,
			{ strokes: Stroke[]; stamps: AnnotationStamp[]; notes: Note[] }[]
		>
	>({});

	// Refs
	let host = $state<HTMLElement | null>(null);
	let leftPdf = $state<HTMLCanvasElement | null>(null);
	let rightPdf = $state<HTMLCanvasElement | null>(null);
	let leftInk = $state<HTMLCanvasElement | null>(null);
	let rightInk = $state<HTMLCanvasElement | null>(null);

	let renderId = 0;
	let resizeTimer: any; // Timer to debounce window resize
	const colors = [
		'#ef4444',
		'#3b82f6',
		'#22c55e',
		'#eab308',
		'#a855f7',
		'#000000'
	];

	type Point = { x: number; y: number; pressure?: number };

	onMount(() => {
		loadScore();
		return () => pdfDoc?.destroy();
	});

	async function loadScore() {
		const data = new Uint8Array(await score.pdfBlob.arrayBuffer());
		pdfDoc = await pdfjsLib.getDocument({ data, isEvalSupported: false })
			.promise;

		const records = await db.annotations
			.where('scoreId')
			.equals(score.id)
			.toArray();
		for (const r of records) {
			annotations[r.pageNum] = r.strokes || [];
			stamps[r.pageNum] = r.stamps || [];
			notes[r.pageNum] = r.notes || [];
			history[r.pageNum] = [snapshot(r.pageNum)];
		}

		await tick();
		renderPages();
	}

	function snapshot(p: number) {
		// Strip proxies before saving snapshot history
		return $state.snapshot({
			strokes: annotations[p] || [],
			stamps: stamps[p] || [],
			notes: notes[p] || []
		});
	}

	function checkpoint(p: number) {
		history[p] = history[p] || [];
		history[p].push(snapshot(p));
		save(p);
	}

	function save(p: number) {
		// CRITICAL FIX: Strip proxies to avoid Dexie DataCloneError
		void db.annotations.put(
			$state.snapshot({
				id: `${score.id}_page_${p}`,
				scoreId: score.id,
				pageNum: p,
				strokes: annotations[p] || [],
				stamps: stamps[p] || [],
				notes: notes[p] || []
			})
		);
	}

	async function renderPages() {
		renderId++;
		const id = renderId;
		if (dual) {
			const l = current % 2 === 0 ? current : Math.max(1, current - 1);
			const r = l + 1;
			await Promise.all([
				renderOne(l, leftPdf, leftInk, id),
				r <= (pdfDoc?.numPages || 1)
					? renderOne(r, rightPdf, rightInk, id)
					: Promise.resolve()
			]);
		} else {
			await renderOne(current, leftPdf, leftInk, id);
		}
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
			: Math.max(240, host.clientWidth - 70);
		const ah = Math.max(240, host.clientHeight - 50);

		let scale = Math.min(aw / base.width, ah / base.height) * zoom;
		const maxPixels = 10_000_000;
		if (base.width * scale * base.height * scale > maxPixels)
			scale = Math.sqrt(maxPixels / (base.width * base.height));

		scale = Math.max(0.2, Math.min(2.2, scale));
		const viewport = page.getViewport({ scale });
		const w = Math.ceil(viewport.width);
		const h = Math.ceil(viewport.height);

		// DEVICE PIXEL RATIO FIX - Sharp text on Retina / High-DPI screens
		const dpr = window.devicePixelRatio || 1;
		pdf.width = w * dpr;
		pdf.height = h * dpr;
		ink.width = w * dpr;
		ink.height = h * dpr;

		pdf.style.width = ink.style.width = `${w}px`;
		pdf.style.height = ink.style.height = `${h}px`;

		const ctxPdf = pdf.getContext('2d')!;
		ctxPdf.scale(dpr, dpr);
		const ctxInk = ink.getContext('2d')!;
		ctxInk.scale(dpr, dpr);

		// Required API change in recent PDF.js: Pass `canvasContext`
		await page.render({ canvasContext: ctxPdf, viewport }).promise;
		if (id === renderId) redraw(p, ink);
	}

	// NORMALIZATION FIX: Target `.getBoundingClientRect()` instead of native width/height to avoid DPR warping
	function norm(p: Point, c: HTMLCanvasElement): Point {
		const r = c.getBoundingClientRect();
		return p.x > 2 || p.y > 2
			? { x: p.x / r.width, y: p.y / r.height, pressure: p.pressure }
			: p;
	}

	function xy(p: Point, c: HTMLCanvasElement) {
		const n = norm(p, c);
		const r = c.getBoundingClientRect();
		return { x: n.x * r.width, y: n.y * r.height };
	}

	function drawSegment(
		ctx: CanvasRenderingContext2D,
		a: Point,
		b: Point,
		c: HTMLCanvasElement,
		s: Stroke
	) {
		ctx.beginPath();
		const p1 = xy(a, c),
			p2 = xy(b, c);
		ctx.moveTo(p1.x, p1.y);
		ctx.lineTo(p2.x, p2.y);
		ctx.strokeStyle = s.color;
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.lineWidth = s.width * (a.pressure ? 0.65 + a.pressure * 0.7 : 1);
		ctx.stroke();
	}

	function drawShape(
		ctx: CanvasRenderingContext2D,
		s: Stroke,
		c: HTMLCanvasElement
	) {
		if (s.points.length < 2) return;
		ctx.beginPath();
		const start = xy(s.points[0], c),
			end = xy(s.points[s.points.length - 1], c);
		ctx.moveTo(start.x, start.y);
		ctx.lineTo(end.x, end.y);
		ctx.strokeStyle = s.color;
		ctx.lineWidth = s.width;
		ctx.stroke();

		if (s.kind === 'arrow') {
			const angle = Math.atan2(end.y - start.y, end.x - start.x);
			const head = s.width * 4;
			ctx.beginPath();
			ctx.moveTo(end.x, end.y);
			ctx.lineTo(
				end.x - head * Math.cos(angle - Math.PI / 6),
				end.y - head * Math.sin(angle - Math.PI / 6)
			);
			ctx.moveTo(end.x, end.y);
			ctx.lineTo(
				end.x - head * Math.cos(angle + Math.PI / 6),
				end.y - head * Math.sin(angle + Math.PI / 6)
			);
			ctx.stroke();
		}
	}

	function redraw(p: number, c: HTMLCanvasElement | null = pageCanvas(p)) {
		if (!c) return;
		const ctx = c.getContext('2d')!;
		const r = c.getBoundingClientRect();
		ctx.clearRect(0, 0, r.width, r.height); // Clearing only logical CSS dimensions since ctx is scaled

		for (const s of annotations[p] || []) {
			// HIGHLIGHTER FIX: Draw as single path to avoid opacity stacking
			if (s.tool === 'highlighter' || s.kind === 'highlighter') {
				if (s.points.length < 2) continue;
				ctx.save();
				ctx.beginPath();
				const start = xy(s.points[0], c);
				ctx.moveTo(start.x, start.y);
				for (let i = 1; i < s.points.length; i++) {
					const pt = xy(s.points[i], c);
					ctx.lineTo(pt.x, pt.y);
				}
				ctx.lineCap = 'round';
				ctx.lineJoin = 'round';
				ctx.globalCompositeOperation = 'multiply';
				ctx.strokeStyle = s.color + '77';
				ctx.lineWidth = Math.max(12, s.width * 5);
				ctx.stroke();
				ctx.restore();
			} else if (s.kind === 'freehand' || !s.kind) {
				// Keep segment-by-segment mapping for pen pressure sensitivity
				for (let i = 1; i < s.points.length; i++)
					drawSegment(ctx, s.points[i - 1], s.points[i], c, s);
			} else if (s.kind === 'line' || s.kind === 'arrow') {
				drawShape(ctx, s, c);
			}
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
	}

	function pageCanvas(p: number) {
		return dual
			? current % 2 === 0
				? p === current
					? leftInk
					: rightInk
				: p === current - 1
					? leftInk
					: rightInk
			: leftInk;
	}

	function pagePoint(e: PointerEvent, c: HTMLCanvasElement): Point {
		const r = c.getBoundingClientRect();
		return {
			x: (e.clientX - r.left) / r.width,
			y: (e.clientY - r.top) / r.height,
			pressure: e.pressure || 0.5
		};
	}

	function start(e: PointerEvent, p: number, c: HTMLCanvasElement) {
		if (tool === 'move' || !annotationOpen || readingMode) return;
		e.preventDefault();
		c.setPointerCapture(e.pointerId);

		const pt = pagePoint(e, c);
		if (tool === 'eraser') {
			eraseAt(pt, p, c);
		} else if (tool === 'sharp' || tool === 'flat' || tool === 'natural') {
			const map = { sharp: '♯', flat: '♭', natural: '♮' };
			(stamps[p] ||= []).push({
				x: pt.x,
				y: pt.y,
				symbol: map[tool],
				color,
				fontSize: 32
			});
			checkpoint(p);
			redraw(p, c);
		} else if (tool === 'text') {
			const n: Note = {
				id: crypto.randomUUID(),
				x: pt.x,
				y: pt.y,
				text: '',
				color
			};
			(notes[p] ||= []).push(n);
			checkpoint(p);
			setTimeout(() => document.getElementById(`note-${n.id}`)?.focus(), 50);
		} else {
			const kind =
				tool === 'highlighter'
					? 'highlighter'
					: tool === 'line'
						? 'line'
						: tool === 'arrow'
							? 'arrow'
							: 'freehand';
			const s: Stroke = {
				id: crypto.randomUUID(),
				tool,
				color,
				width: strokeWidth,
				points: [pt],
				kind
			};
			(annotations[p] ||= []).push(s);

			const move = (me: PointerEvent) => {
				const q = pagePoint(me, c);
				if (tool === 'eraser') eraseAt(q, p, c);
				else {
					s.points.push(q);
					// Single continuous path redrawing required on drag for line/arrow/highlighter
					if (kind !== 'freehand') redraw(p, c);
					else
						drawSegment(
							c.getContext('2d')!,
							s.points[s.points.length - 2],
							q,
							c,
							s
						);
				}
			};
			const up = () => {
				c.removeEventListener('pointermove', move);
				c.removeEventListener('pointerup', up);
				c.releasePointerCapture(e.pointerId);
				if (s.points.length > 1) checkpoint(p);
				redraw(p, c);
			};
			c.addEventListener('pointermove', move);
			c.addEventListener('pointerup', up);
		}
	}

	function eraseAt(pt: Point, p: number, c: HTMLCanvasElement) {
		const r = 0.02;
		let changed = false;
		if (annotations[p]) {
			const init = annotations[p].length;
			annotations[p] = annotations[p].filter(
				(s) => !s.points.some((q) => Math.hypot(q.x - pt.x, q.y - pt.y) < r)
			);
			if (annotations[p].length !== init) changed = true;
		}
		if (stamps[p]) {
			const init = stamps[p].length;
			stamps[p] = stamps[p].filter(
				(s) => Math.hypot(s.x - pt.x, s.y - pt.y) > r
			);
			if (stamps[p].length !== init) changed = true;
		}
		if (changed) {
			checkpoint(p);
			redraw(p, c);
		}
	}

	function undo() {
		const p = current;
		const h = history[p];
		if (!h || h.length <= 1) return;
		h.pop();
		const last = h[h.length - 1];
		// Parse snapshots safely back into states
		annotations[p] = JSON.parse(JSON.stringify(last.strokes));
		stamps[p] = JSON.parse(JSON.stringify(last.stamps));
		notes[p] = JSON.parse(JSON.stringify(last.notes));
		save(p);
		redraw(p);
	}

	function nav(delta: number) {
		const np = pdfDoc?.numPages || 1;
		const nxt = dual ? current + delta * 2 : current + delta;
		if (nxt >= 1 && nxt <= np) {
			current = nxt;
			renderPages();
		}
	}

	function key(e: KeyboardEvent) {
		if (e.key === 'Escape' && readingMode) readingMode = false;
		if (e.target instanceof HTMLTextAreaElement) return;
		if (e.key === 'ArrowRight' || e.key === ' ') nav(1);
		else if (e.key === 'ArrowLeft') nav(-1);
		else if (e.key === 'z' && (e.metaKey || e.ctrlKey)) undo();
	}
</script>

<svelte:window
	onkeydown={key}
	onresize={() => { clearTimeout(resizeTimer); resizeTimer = setTimeout(renderPages, 200) as any; }} />

<div
	class="fixed inset-0 bg-neutral-950 flex flex-col z-50 overflow-hidden font-sans text-neutral-200 selection:bg-violet-500/30">
	<!-- Top Bar -->
	<header
		class="h-14 shrink-0 border-b border-neutral-900 bg-neutral-950/80 backdrop-blur flex items-center px-4 justify-between transition-transform duration-300 {readingMode
			? '-translate-y-full'
			: ''}">
		<div class="flex items-center gap-4 w-1/3">
			<button
				class="p-2 -ml-2 rounded-xl text-neutral-400 hover:text-white hover:bg-neutral-900 transition-colors"
				onclick={onClose}>
				<ArrowLeft size={18} />
			</button>
			<div class="min-w-0">
				<h1 class="text-sm font-semibold truncate text-white">{score.title}</h1>
				<p class="text-[11px] text-neutral-500 truncate">{score.composer}</p>
			</div>
		</div>

		<div class="flex items-center justify-center gap-1.5 w-1/3">
			<button
				class="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-900"
				onclick={() => nav(-1)}><ChevronLeft size={18} /></button>
			<span
				class="text-xs font-medium tabular-nums w-12 text-center text-neutral-300">
				{current} / {pdfDoc?.numPages || '?'}
			</span>
			<button
				class="p-1.5 rounded-lg text-neutral-400 hover:bg-neutral-900"
				onclick={() => nav(1)}><ChevronRight size={18} /></button>
		</div>

		<div class="flex items-center justify-end gap-2 w-1/3">
			<div
				class="flex items-center bg-neutral-900/50 rounded-lg p-1 mr-2 border border-neutral-800/50">
				<button
					class="p-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
					onclick={() => {
						zoom -= 0.1;
						renderPages();
					}}><ZoomOut size={16} /></button>
				<span class="text-[11px] font-medium w-9 text-center text-neutral-400"
					>{Math.round(zoom * 100)}%</span>
				<button
					class="p-1.5 rounded-md text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors"
					onclick={() => {
						zoom += 0.1;
						renderPages();
					}}><ZoomIn size={16} /></button>
			</div>

			<button
				class="p-2 rounded-xl border transition-colors {dual
					? 'bg-violet-600 border-violet-500 text-white shadow-sm shadow-violet-900/20'
					: 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:bg-neutral-800'}"
				onclick={() => {
					dual = !dual;
					renderPages();
				}}
				title="Two Page View">
				<BookOpen size={16} />
			</button>
			<button
				class="p-2 rounded-xl border transition-colors {annotationOpen
					? 'bg-violet-600 border-violet-500 text-white shadow-sm shadow-violet-900/20'
					: 'bg-neutral-900 border-neutral-800 text-neutral-400 hover:bg-neutral-800'}"
				onclick={() => (annotationOpen = !annotationOpen)}
				title="Annotations">
				<PenTool size={16} />
			</button>
			<button
				class="ml-1 px-3 py-1.5 text-xs font-medium bg-white text-black rounded-xl hover:bg-neutral-200 transition-colors"
				onclick={() => (readingMode = true)}>Read</button>
		</div>
	</header>

	<div class="flex-1 flex overflow-hidden relative">
		<!-- Annotation Toolbar -->
		<aside
			class="w-14 shrink-0 bg-neutral-950 border-r border-neutral-900 flex flex-col items-center py-4 gap-4 transition-all duration-300 absolute md:relative z-20 h-full {annotationOpen &&
			!readingMode
				? 'translate-x-0'
				: '-translate-x-full md:hidden md:w-0'}">
			<!-- Toolbar identical to original -->
			<div class="flex flex-col gap-1.5 w-full px-2">
				{@render toolBtn('move', MousePointer2)}
				{@render toolBtn('pen', PenTool)}
				{@render toolBtn('highlighter', Highlighter)}
				{@render toolBtn('line', Minus)}
				<div class="h-px w-6 mx-auto bg-neutral-800 my-1"></div>
				<button
					class="p-2 rounded-xl text-lg flex justify-center {tool === 'sharp'
						? 'bg-violet-600 text-white'
						: 'text-neutral-400 hover:bg-neutral-900'}"
					onclick={() => (tool = 'sharp')}>♯</button>
				<button
					class="p-2 rounded-xl text-lg flex justify-center {tool === 'flat'
						? 'bg-violet-600 text-white'
						: 'text-neutral-400 hover:bg-neutral-900'}"
					onclick={() => (tool = 'flat')}>♭</button>
				<div class="h-px w-6 mx-auto bg-neutral-800 my-1"></div>
				{@render toolBtn('text', Type)}
				{@render toolBtn('eraser', Eraser)}
			</div>
			<div class="mt-auto flex flex-col gap-3 w-full px-2">
				<button
					class="p-2 rounded-xl text-neutral-400 hover:bg-neutral-900 mx-auto"
					onclick={undo}
					title="Undo (Ctrl+Z)"><Undo2 size={18} /></button>
				<div class="grid grid-cols-2 gap-1.5 px-1">
					{#each colors as c}
						<button
							class="w-4 h-4 rounded-full ring-2 ring-offset-2 ring-offset-neutral-950 transition-all {color ===
							c
								? 'ring-white scale-110'
								: 'ring-transparent hover:scale-110'}"
							style:background-color={c}
							onclick={() => (color = c)}></button>
					{/each}
				</div>
			</div>
		</aside>

		<!-- Main Workspace -->
		<main
			bind:this={host}
			class="flex-1 bg-neutral-900 overflow-auto relative flex items-center justify-center p-4 sm:p-8"
			onclick={() => {
				if (readingMode) readingMode = false;
			}}>
			<div
				class="flex gap-4 sm:gap-8 items-center justify-center min-h-full transition-transform duration-300 {readingMode
					? 'scale-[1.02]'
					: ''}">
				<!-- Left Page -->
				<div
					class="relative shadow-2xl shadow-black/50 bg-white ring-1 ring-neutral-950/5 rounded-sm"
					style="touch-action: none;">
					<canvas bind:this={leftPdf} class="block rounded-sm"></canvas>
					<canvas
						bind:this={leftInk}
						class="absolute inset-0 z-10 w-full h-full cursor-crosshair rounded-sm"
						onpointerdown={(e) => start(e, dual ? (current % 2 === 0 ? current : Math.max(1, current - 1)) : current, leftInk!)}
					></canvas>

					<!-- Left Page Notes -->
					<div
						class="absolute inset-0 pointer-events-none overflow-hidden z-20">
						{#each notes[dual ? (current % 2 === 0 ? current : Math.max(1, current - 1)) : current] || [] as n}
							<textarea
								id="note-{n.id}"
								bind:value={n.text}
								oninput={() => {
									n.text = n.text;
									checkpoint(current);
								}}
								class="absolute bg-transparent outline-none resize-none overflow-hidden whitespace-pre pointer-events-auto leading-tight"
								style:left="{n.x * 100}%"
								style:top="{n.y * 100}%"
								style:color={n.color}
								style:font-size="16px"
								style:font-family="sans-serif"
								ondblclick={() => (tool = 'move')}
								onmousedown={(e) => tool === 'move' && e.stopPropagation()}
							></textarea>
						{/each}
					</div>
				</div>

				<!-- Right Page (Dual Mode) -->
				{#if dual && (current % 2 === 0 ? current + 1 : Math.max(1, current - 1) + 1) <= (pdfDoc?.numPages || 1)}
					<div
						class="relative shadow-2xl shadow-black/50 bg-white ring-1 ring-neutral-950/5 rounded-sm hidden md:block"
						style="touch-action: none;">
						<canvas bind:this={rightPdf} class="block rounded-sm"></canvas>
						<canvas
							bind:this={rightInk}
							class="absolute inset-0 z-10 w-full h-full cursor-crosshair rounded-sm"
							onpointerdown={(e) => start(e, current % 2 === 0 ? current + 1 : Math.max(1, current - 1) + 1, rightInk!)}
						></canvas>
					</div>
				{/if}
			</div>
		</main>
	</div>
</div>

{#snippet toolBtn(id: Tool, Icon: any)}
	<button
		class="p-2 rounded-xl flex justify-center transition-colors {tool === id
			? 'bg-violet-600 text-white shadow-sm shadow-violet-900/20'
			: 'text-neutral-400 hover:bg-neutral-900'}"
		onclick={() => (tool = id)}>
		<Icon size={18} strokeWidth={2.5} />
	</button>
{/snippet}
