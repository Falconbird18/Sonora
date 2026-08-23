<script lang="ts">
	import { onMount } from 'svelte';
	import * as pdfjsLib from 'pdfjs-dist';
	import {
		ArrowLeft,
		ChevronLeft,
		ChevronRight,
		Pencil,
		Highlighter,
		Eraser,
		Trash2,
		Sun,
		Moon,
		BookOpen,
		Columns,
		Square,
		ZoomIn,
		ZoomOut,
		RotateCcw,
		Undo,
		Redo,
		Music2,
		Type,
		Search
	} from 'lucide-svelte';
	import { db } from './db';
	import type { ScoreItem, Stroke, SymbolStamp, TextNote } from './types';
	import {
		MUSICAL_SYMBOLS,
		SYMBOL_CATEGORIES,
		type SymbolCategory
	} from './musicSymbols';

	let { score, onBack }: { score: ScoreItem; onBack: () => void } = $props();
	let pdfDoc = $state<pdfjsLib.PDFDocumentProxy | null>(null);
	let currentPage = $state(1),
		totalPages = $state(0);
	let filterMode = $state<'normal' | 'sepia' | 'dark'>('normal');
	let isDualPage = $state(false),
		fitMode = $state<'height' | 'width' | 'page'>('height'),
		zoomLevel = $state(1);
	let isAnnotationToolOpen = $state(false);
	let activeTool = $state<'pen' | 'highlighter' | 'stamp' | 'text' | 'eraser'>(
		'pen'
	);
	let penColor = $state('#ef4444'),
		penWidth = $state(3);
	let selectedSymbol = $state(MUSICAL_SYMBOLS[0].symbol),
		symbolCategory = $state<SymbolCategory>('Common'),
		symbolSearch = $state('');
	let annotations = $state<Record<number, Stroke[]>>({}),
		stamps = $state<Record<number, SymbolStamp[]>>({}),
		notes = $state<Record<number, TextNote[]>>({});
	let historyStack = $state<
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
		isDrawing = false,
		drawingPage = 0;
	let leftPdfCanvas = $state<HTMLCanvasElement | null>(null),
		leftDrawCanvas = $state<HTMLCanvasElement | null>(null),
		rightPdfCanvas = $state<HTMLCanvasElement | null>(null),
		rightDrawCanvas = $state<HTMLCanvasElement | null>(null),
		mainContainerRef = $state<HTMLDivElement | null>(null);
	let saveTimers: Record<number, ReturnType<typeof setTimeout> | undefined> =
		{};
	let renderToken = 0;
	const QUICK_COLORS = [
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
				(symbolSearch.trim() === '' ||
					[s.label, ...s.keywords]
						.join(' ')
						.toLowerCase()
						.includes(symbolSearch.toLowerCase()))
		)
	);

	onMount(async () => {
		isDualPage = window.innerWidth >= 1024;
		// PDF.js 6 uses an ESM worker. Explicitly supplying it prevents the entire PDF parser
		// from falling back to the main thread, which is particularly painful with long scores.
		pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
			'pdfjs-dist/build/pdf.worker.min.mjs',
			import.meta.url
		).toString();
		try {
			pdfDoc = await pdfjsLib.getDocument({
				data: new Uint8Array(await score.pdfBlob.arrayBuffer()),
				disableAutoFetch: false,
				disableStream: false
			}).promise;
			totalPages = pdfDoc.numPages;
			const saved = await db.annotations
				.where('scoreId')
				.equals(score.id)
				.toArray();
			for (const r of saved) {
				annotations[r.pageNum] = r.strokes || [];
				stamps[r.pageNum] = r.stamps || [];
				notes[r.pageNum] = r.notes || [];
			}
			await renderPages();
		} catch (err) {
			console.error('PDF error:', err);
		}
	});

	const snapshot = (p: number) => ({
		strokes: structuredClone(annotations[p] || []),
		stamps: structuredClone(stamps[p] || []),
		notes: structuredClone(notes[p] || [])
	});
	function history(p: number) {
		(historyStack[p] ||= []).push(snapshot(p));
		if (historyStack[p].length > 50) historyStack[p].shift();
		redoStack[p] = [];
	}
	function scheduleSave(p: number) {
		if (saveTimers[p]) clearTimeout(saveTimers[p]);
		saveTimers[p] = setTimeout(() => saveToDb(p), 160);
	}
	async function saveToDb(p: number) {
		await db.annotations.put({
			id: `${score.id}_page_${p}`,
			scoreId: score.id,
			pageNum: p,
			strokes: annotations[p] || [],
			stamps: stamps[p] || [],
			notes: notes[p] || []
		});
	}

	function undo(p: number) {
		if (!historyStack[p]?.length) return;
		(redoStack[p] ||= []).push(snapshot(p));
		const s = historyStack[p].pop()!;
		annotations[p] = s.strokes;
		stamps[p] = s.stamps;
		notes[p] = s.notes;
		redrawOverlay(p, canvasForPage(p));
		scheduleSave(p);
	}
	function redo(p: number) {
		if (!redoStack[p]?.length) return;
		history(p);
		const s = redoStack[p].pop()!;
		annotations[p] = s.strokes;
		stamps[p] = s.stamps;
		notes[p] = s.notes;
		redrawOverlay(p, canvasForPage(p));
		scheduleSave(p);
	}
	function canvasForPage(p: number) {
		return p === currentPage
			? leftDrawCanvas
			: isDualPage && p === currentPage + 1
				? rightDrawCanvas
				: null;
	}

	async function renderPages() {
		if (!pdfDoc || !mainContainerRef) return;
		const token = ++renderToken;
		await renderSinglePage(currentPage, leftPdfCanvas, leftDrawCanvas, token);
		if (token !== renderToken) return;
		if (isDualPage && currentPage + 1 <= totalPages)
			await renderSinglePage(
				currentPage + 1,
				rightPdfCanvas,
				rightDrawCanvas,
				token
			);
	}

	async function renderSinglePage(
		p: number,
		pdfCanvas: HTMLCanvasElement | null,
		drawCanvas: HTMLCanvasElement | null,
		token: number
	) {
		if (!pdfDoc || !pdfCanvas || !drawCanvas || !mainContainerRef) return;
		const page = await pdfDoc.getPage(p);
		if (token !== renderToken) return;
		const base = page.getViewport({ scale: 1 });
		const w = isDualPage
			? Math.max(240, (mainContainerRef.clientWidth - 96) / 2)
			: Math.max(240, mainContainerRef.clientWidth - 64);
		const h = Math.max(240, mainContainerRef.clientHeight - 48);
		const fit =
			fitMode === 'height'
				? h / base.height
				: fitMode === 'width'
					? w / base.width
					: Math.min(w / base.width, h / base.height);
		const viewport = page.getViewport({
			scale: Math.max(0.25, Math.min(4, fit * zoomLevel))
		});
		const width = Math.ceil(viewport.width),
			height = Math.ceil(viewport.height);
		pdfCanvas.width = width;
		pdfCanvas.height = height;
		drawCanvas.width = width;
		drawCanvas.height = height;
		pdfCanvas.style.width = `${width}px`;
		pdfCanvas.style.height = `${height}px`;
		drawCanvas.style.width = `${width}px`;
		drawCanvas.style.height = `${height}px`;
		await page.render({
			canvasContext: pdfCanvas.getContext('2d', { alpha: false })!,
			viewport
		}).promise;
		if (token === renderToken) redrawOverlay(p, drawCanvas);
	}

	function drawStrokeSegment(
		ctx: CanvasRenderingContext2D,
		a: { x: number; y: number },
		b: { x: number; y: number },
		tool: 'pen' | 'highlighter',
		color: string,
		width: number
	) {
		ctx.save();
		ctx.beginPath();
		ctx.moveTo(a.x, a.y);
		ctx.lineTo(b.x, b.y);
		ctx.lineCap = 'round';
		ctx.lineJoin = 'round';
		ctx.strokeStyle = tool === 'highlighter' ? 'rgba(250,204,21,.4)' : color;
		ctx.lineWidth = tool === 'highlighter' ? Math.max(12, width * 5) : width;
		ctx.stroke();
		ctx.restore();
	}
	function redrawOverlay(p: number, canvas: HTMLCanvasElement | null) {
		if (!canvas) return;
		const ctx = canvas.getContext('2d')!;
		ctx.clearRect(0, 0, canvas.width, canvas.height);
		for (const s of annotations[p] || [])
			for (let i = 1; i < s.points.length; i++)
				drawStrokeSegment(
					ctx,
					s.points[i - 1],
					s.points[i],
					s.tool,
					s.color,
					s.width
				);
		for (const s of stamps[p] || []) {
			ctx.save();
			ctx.font = `${s.fontSize}px Leland, serif`;
			ctx.fillStyle = s.color;
			ctx.textAlign = 'center';
			ctx.textBaseline = 'middle';
			ctx.fillText(s.symbol, s.x, s.y);
			ctx.restore();
		}
		for (const n of notes[p] || []) {
			ctx.save();
			ctx.font = `600 ${n.fontSize}px sans-serif`;
			ctx.fillStyle = n.color;
			ctx.fillText(n.text, n.x, n.y);
			ctx.restore();
		}
	}

	function handlePointerDown(
		e: PointerEvent,
		p: number,
		canvas: HTMLCanvasElement
	) {
		if (!isAnnotationToolOpen) return;
		if (e.pointerType === 'pen') activeTool = 'pen';
		const r = canvas.getBoundingClientRect(),
			x = e.clientX - r.left,
			y = e.clientY - r.top;
		if (activeTool === 'stamp') {
			history(p);
			(stamps[p] ||= []).push({
				id: crypto.randomUUID(),
				symbol: selectedSymbol,
				label: 'stamp',
				x,
				y,
				fontSize: 34,
				color: penColor
			});
			redrawOverlay(p, canvas);
			scheduleSave(p);
			return;
		}
		if (activeTool === 'text') {
			const text = prompt('Enter rehearsal note / instruction:');
			if (text?.trim()) {
				history(p);
				(notes[p] ||= []).push({
					id: crypto.randomUUID(),
					text: text.trim(),
					x,
					y,
					fontSize: 16,
					color: penColor
				});
				redrawOverlay(p, canvas);
				scheduleSave(p);
			}
			return;
		}
		isDrawing = true;
		drawingPage = p;
		canvas.setPointerCapture(e.pointerId);
		if (activeTool === 'eraser') {
			history(p);
			eraseAtPoint(x, y, p, canvas);
			return;
		}
		history(p);
		currentStroke = {
			tool: activeTool === 'highlighter' ? 'highlighter' : 'pen',
			color: penColor,
			width: penWidth,
			points: [{ x, y }]
		};
	}

	function handlePointerMove(
		e: PointerEvent,
		p: number,
		canvas: HTMLCanvasElement
	) {
		if (!isDrawing || drawingPage !== p) return;
		const r = canvas.getBoundingClientRect(),
			x = e.clientX - r.left,
			y = e.clientY - r.top;
		if (activeTool === 'eraser') {
			eraseAtPoint(x, y, p, canvas);
			return;
		}
		if (!currentStroke) return;
		const pts = currentStroke.points,
			last = pts[pts.length - 1];
		if (Math.hypot(x - last.x, y - last.y) < 1.25) return;
		pts.push({ x, y });
		// Draw only the new segment. The previous implementation redrew every existing stroke
		// for every pointer event, making annotation latency grow with the number of marks.
		drawStrokeSegment(
			canvas.getContext('2d')!,
			last,
			{ x, y },
			currentStroke.tool,
			currentStroke.color,
			currentStroke.width
		);
	}

	function handlePointerUp(
		e: PointerEvent,
		p: number,
		canvas: HTMLCanvasElement
	) {
		if (!isDrawing || drawingPage !== p) return;
		isDrawing = false;
		if (canvas.hasPointerCapture(e.pointerId))
			canvas.releasePointerCapture(e.pointerId);
		if (
			activeTool !== 'eraser' &&
			currentStroke &&
			currentStroke.points.length > 1
		) {
			(annotations[p] ||= []).push(currentStroke);
			scheduleSave(p);
		} else if (activeTool === 'eraser') scheduleSave(p);
		currentStroke = null;
		redrawOverlay(p, canvas);
	}
	function eraseAtPoint(
		x: number,
		y: number,
		p: number,
		canvas: HTMLCanvasElement
	) {
		const radius = 24;
		annotations[p] = (annotations[p] || []).filter(
			(s) => !s.points.some((q) => Math.hypot(q.x - x, q.y - y) < radius)
		);
		stamps[p] = (stamps[p] || []).filter(
			(s) => Math.hypot(s.x - x, s.y - y) > radius + 8
		);
		notes[p] = (notes[p] || []).filter(
			(n) => Math.hypot(n.x - x, n.y - y) > radius + 8
		);
		redrawOverlay(p, canvas);
	}
	function goToPage(n: number) {
		const step = isDualPage ? 2 : 1;
		const p = isDualPage ? (n % 2 === 0 ? n - 1 : n) : n;
		if (p >= 1 && p <= totalPages) {
			currentPage = p;
			void renderPages();
		}
	}
	function handleKeyDown(e: KeyboardEvent) {
		const t = e.target as HTMLElement;
		if (['INPUT', 'TEXTAREA'].includes(t.tagName)) return;
		const step = isDualPage ? 2 : 1;
		if (e.key === 'ArrowRight' || e.key === 'PageDown')
			goToPage(currentPage + step);
		if (e.key === 'ArrowLeft' || e.key === 'PageUp')
			goToPage(currentPage - step);
		if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
			e.preventDefault();
			undo(currentPage);
		}
		if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
			e.preventDefault();
			redo(currentPage);
		}
		if (e.key.toLowerCase() === 'p') activeTool = 'pen';
		if (e.key.toLowerCase() === 'h') activeTool = 'highlighter';
		if (e.key.toLowerCase() === 's') activeTool = 'stamp';
		if (e.key.toLowerCase() === 'e') activeTool = 'eraser';
	}
</script>

<svelte:window onkeydown={handleKeyDown} />
<div
	class="flex-1 flex flex-col relative bg-neutral-950 overflow-hidden select-none">
	<header
		class="flex items-center justify-between px-4 py-2.5 bg-neutral-900/90 backdrop-blur-md border-b border-neutral-800 z-20">
		<button
			onclick={onBack}
			class="flex items-center gap-2 text-neutral-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-neutral-800">
			<ArrowLeft size={18} />
			<span class="text-sm font-medium">Library</span>
		</button>
		<div class="text-center truncate px-2">
			<h2 class="text-sm font-semibold text-neutral-200 truncate">
				{score.title}
			</h2>
			<p class="text-xs text-neutral-500">{score.composer}</p>
		</div>
		<div class="flex items-center gap-2">
			<div
				class="flex items-center bg-neutral-950 rounded-xl border border-neutral-800 p-1">
				<button
					onclick={() => {
						zoomLevel = Math.max(0.5, zoomLevel - 0.15);
						void renderPages();
					}}
					class="p-1.5 text-neutral-400 hover:text-white">
					<ZoomOut size={16} />
				</button>
				<span class="text-xs font-mono px-2 text-neutral-300"
					>{Math.round(zoomLevel * 100)}%</span>
				<button
					onclick={() => {
						zoomLevel = Math.min(3, zoomLevel + 0.15);
						void renderPages();
					}}
					class="p-1.5 text-neutral-400 hover:text-white">
					<ZoomIn size={16} />
				</button>
				<button
					onclick={() => {
						zoomLevel = 1;
						fitMode = 'height';
						void renderPages();
					}}
					class="p-1.5 text-neutral-400 border-l border-neutral-800 pl-2">
					<RotateCcw size={14} />
				</button>
			</div>
			<div
				class="hidden md:flex bg-neutral-950 rounded-xl border border-neutral-800 p-1 text-xs">
				{#each [['height', 'Fit Height'], ['width', 'Fit Width'], ['page', 'Fit Page']] as [mode, label]}
					<button
						onclick={()=>{fitMode=mode as typeof fitMode;void renderPages()}}
						class="px-2 py-1 rounded-lg {fitMode === mode
							? 'bg-neutral-800 text-blue-400 font-semibold'
							: 'text-neutral-400'}">
						{label}
					</button>
				{/each}
			</div>
			<button
				onclick={() => {
					isDualPage = !isDualPage;
					void renderPages();
				}}
				class="p-2 rounded-xl border border-neutral-800 bg-neutral-950 text-neutral-400">
				{#if isDualPage}
					<Columns size={16} class="text-blue-400" />
				{:else}
					<Square size={16} />
				{/if}
			</button>
			<div
				class="flex items-center gap-1 bg-neutral-950 p-1 rounded-xl border border-neutral-800">
				<button
					title="Normal"
					class="p-1.5 rounded-lg {filterMode === 'normal'
						? 'bg-neutral-800 text-white'
						: 'text-neutral-500'}"
					onclick={() => (filterMode = 'normal')}>
					<Sun size={16} />
				</button>
				<button
					title="Sepia"
					class="p-1.5 rounded-lg {filterMode === 'sepia'
						? 'bg-amber-900/60 text-amber-200'
						: 'text-neutral-500'}"
					onclick={() => (filterMode = 'sepia')}>
					<BookOpen size={16} />
				</button>
				<button
					title="Dark"
					class="p-1.5 rounded-lg {filterMode === 'dark'
						? 'bg-neutral-800 text-white'
						: 'text-neutral-500'}"
					onclick={() => (filterMode = 'dark')}>
					<Moon size={16} />
				</button>
			</div>
		</div>
	</header>
	<div
		bind:this={mainContainerRef}
		class="flex-1 overflow-auto flex justify-center items-center p-2 relative">
		<button
			disabled={currentPage <= 1}
			onclick={() => goToPage(currentPage - (isDualPage ? 2 : 1))}
			class="absolute left-0 top-0 bottom-0 w-1/6 z-10 flex items-center justify-start pl-4 opacity-0 hover:opacity-100 hover:bg-gradient-to-r hover:from-neutral-900/40 hover:to-transparent {isAnnotationToolOpen
				? 'pointer-events-none'
				: ''}"><ChevronLeft size={36} class="text-white/70" /></button>
		<button
			disabled={currentPage >= totalPages}
			onclick={() => goToPage(currentPage + (isDualPage ? 2 : 1))}
			class="absolute right-0 top-0 bottom-0 w-1/6 z-10 flex items-center justify-end pr-4 opacity-0 hover:opacity-100 hover:bg-gradient-to-l hover:from-neutral-900/40 hover:to-transparent {isAnnotationToolOpen
				? 'pointer-events-none'
				: ''}"><ChevronRight size={36} class="text-white/70" /></button>
		<div
			class="flex gap-4 max-w-full max-h-full justify-center items-center z-0">
			<div
				class="relative shadow-2xl rounded overflow-hidden bg-white {filterMode ===
				'sepia'
					? 'sepia contrast-105 brightness-95'
					: ''} {filterMode === 'dark'
					? 'invert hue-rotate-180 contrast-125'
					: ''}">
				<canvas bind:this={leftPdfCanvas} class="block"></canvas><canvas
					bind:this={leftDrawCanvas}
					onpointerdown={(e) =>
						leftDrawCanvas && handlePointerDown(e, currentPage, leftDrawCanvas)}
					onpointermove={(e) =>
						leftDrawCanvas && handlePointerMove(e, currentPage, leftDrawCanvas)}
					onpointerup={(e) =>
						leftDrawCanvas && handlePointerUp(e, currentPage, leftDrawCanvas)}
					onpointercancel={(e) =>
						leftDrawCanvas && handlePointerUp(e, currentPage, leftDrawCanvas)}
					class="absolute top-0 left-0 touch-none {isAnnotationToolOpen
						? 'cursor-crosshair'
						: 'pointer-events-none'}"></canvas>
			</div>
			{#if isDualPage && currentPage + 1 <= totalPages}<div
					class="relative shadow-2xl rounded overflow-hidden bg-white {filterMode ===
					'sepia'
						? 'sepia contrast-105 brightness-95'
						: ''} {filterMode === 'dark'
						? 'invert hue-rotate-180 contrast-125'
						: ''}">
					<canvas bind:this={rightPdfCanvas} class="block"></canvas><canvas
						bind:this={rightDrawCanvas}
						onpointerdown={(e) =>
							rightDrawCanvas &&
							handlePointerDown(e, currentPage + 1, rightDrawCanvas)}
						onpointermove={(e) =>
							rightDrawCanvas &&
							handlePointerMove(e, currentPage + 1, rightDrawCanvas)}
						onpointerup={(e) =>
							rightDrawCanvas &&
							handlePointerUp(e, currentPage + 1, rightDrawCanvas)}
						onpointercancel={(e) =>
							rightDrawCanvas &&
							handlePointerUp(e, currentPage + 1, rightDrawCanvas)}
						class="absolute top-0 left-0 touch-none {isAnnotationToolOpen
							? 'cursor-crosshair'
							: 'pointer-events-none'}"></canvas>
				</div>{/if}
		</div>
	</div>
	{#if isAnnotationToolOpen}<div
			class="absolute top-14 left-1/2 -translate-x-1/2 z-30 bg-neutral-900/95 backdrop-blur-xl border border-neutral-700/80 p-2.5 rounded-2xl shadow-2xl flex flex-col gap-2 w-[min(760px,calc(100vw-24px))]">
			<div class="flex items-center gap-2 overflow-x-auto">
				<button
					class="p-2 rounded-xl {activeTool === 'pen'
						? 'bg-blue-600 text-white'
						: 'text-neutral-400'}"
					onclick={() => (activeTool = 'pen')}
					title="Pen (P)">
					<Pencil size={18} />
				</button>
				<button
					class="p-2 rounded-xl {activeTool === 'highlighter'
						? 'bg-yellow-500/20 text-yellow-400'
						: 'text-neutral-400'}"
					onclick={() => (activeTool = 'highlighter')}
					title="Highlighter (H)">
					<Highlighter size={18} />
				</button>
				<button
					class="p-2 rounded-xl {activeTool === 'stamp'
						? 'bg-purple-600 text-white'
						: 'text-neutral-400'}"
					onclick={() => (activeTool = 'stamp')}
					title="Musical symbols (S)">
					<Music2 size={18} />
				</button>
				<button
					class="p-2 rounded-xl {activeTool === 'text'
						? 'bg-emerald-600 text-white'
						: 'text-neutral-400'}"
					onclick={() => (activeTool = 'text')}
					title="Text note">
					<Type size={18} />
				</button>
				<button
					class="p-2 rounded-xl {activeTool === 'eraser'
						? 'bg-neutral-800 text-white'
						: 'text-neutral-400'}"
					onclick={() => (activeTool = 'eraser')}
					title="Eraser (E)"><Eraser size={18} /></button
				>
				<div class="h-5 w-px bg-neutral-800 mx-1"></div>
				{#each QUICK_COLORS as color}<button
						aria-label={`Color ${color}`}
						onclick={() => (penColor = color)}
						style="background-color:{color}"
						class="w-5 h-5 rounded-full border border-neutral-700 {penColor ===
						color
							? 'ring-2 ring-blue-500 scale-110'
							: ''}"></button
					>{/each}
				<div class="h-5 w-px bg-neutral-800 mx-1"></div>
				<button
					onclick={() => undo(currentPage)}
					class="p-2 text-neutral-400 hover:text-white"
					title="Undo"><Undo size={16} /></button
				><button
					onclick={() => redo(currentPage)}
					class="p-2 text-neutral-400 hover:text-white"
					title="Redo"><Redo size={16} /></button
				><button
					onclick={() => {
						history(currentPage);
						annotations[currentPage] = [];
						stamps[currentPage] = [];
						notes[currentPage] = [];
						redrawOverlay(currentPage, leftDrawCanvas);
						scheduleSave(currentPage);
					}}
					class="p-2 text-neutral-400 hover:text-red-400"
					title="Clear page"><Trash2 size={16} /></button>
			</div>
			{#if activeTool === 'stamp'}<div
					class="border-t border-neutral-800 pt-2 space-y-2">
					<div class="relative">
						<Search
							size={15}
							class="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" /><input
							bind:value={symbolSearch}
							placeholder="Search musical symbols…"
							class="w-full bg-neutral-950 border border-neutral-800 rounded-lg pl-8 pr-3 py-1.5 text-xs text-neutral-200 outline-none focus:border-purple-500" />
					</div>
					<div class="flex gap-1 overflow-x-auto pb-1">
						{#each SYMBOL_CATEGORIES as category}<button
								onclick={() => (symbolCategory = category)}
								class="px-2.5 py-1 rounded-lg text-[11px] whitespace-nowrap {symbolCategory ===
								category
									? 'bg-purple-600/25 text-purple-200 border border-purple-500/50'
									: 'text-neutral-400 bg-neutral-950 border border-neutral-800'}"
								>{category}</button
							>{/each}
					</div>
					<div
						class="grid grid-cols-6 sm:grid-cols-8 md:grid-cols-10 gap-1.5 max-h-32 overflow-y-auto">
						{#each filteredSymbols as item}<button
								onclick={() => (selectedSymbol = item.symbol)}
								title={item.label}
								class="aspect-square rounded-lg border {selectedSymbol ===
								item.symbol
									? 'bg-purple-600/25 border-purple-500 text-purple-100'
									: 'bg-neutral-950 border-neutral-800 text-neutral-300 hover:bg-neutral-800'} flex flex-col items-center justify-center"
								><span
									class="text-2xl leading-none"
									style="font-family:Leland,serif">{item.symbol}</span
								><span class="text-[8px] text-neutral-500 truncate w-full px-1"
									>{item.label}</span
								></button
							>{/each}
					</div>
				</div>{/if}
		</div>{/if}
	<footer class="p-3 flex justify-center z-20">
		<div
			class="bg-neutral-900/90 backdrop-blur-xl border border-neutral-800 px-6 py-2 rounded-2xl shadow-2xl flex items-center gap-6">
			<div class="flex items-center gap-2">
				<button
					disabled={currentPage <= 1}
					onclick={() => goToPage(currentPage - (isDualPage ? 2 : 1))}
					class="p-2 bg-neutral-800 disabled:opacity-30 rounded-xl">
					<ChevronLeft size={18} />
				</button>
				<span
					class="text-xs font-semibold text-neutral-300 min-w-[90px] text-center"
					>{currentPage}{isDualPage && currentPage + 1 <= totalPages
						? ` - ${currentPage + 1}`
						: ''} / {totalPages}</span>
				<button
					disabled={currentPage >= totalPages}
					onclick={() => goToPage(currentPage + (isDualPage ? 2 : 1))}
					class="p-2 bg-neutral-800 disabled:opacity-30 rounded-xl">
					<ChevronRight size={18} />
				</button>
			</div>
			<div class="h-5 w-px bg-neutral-800"></div>
			<button
				onclick={() => (isAnnotationToolOpen = !isAnnotationToolOpen)}
				class="flex items-center gap-2 px-4 py-2 rounded-xl text-xs font-semibold {isAnnotationToolOpen
					? 'bg-blue-600 text-white'
					: 'bg-neutral-800 text-neutral-300'}">
				<Pencil size={16} />
				<span>Annotate</span>
			</button>
		</div>
	</footer>
</div>

<style>
	@font-face {
		font-family: 'Leland';
		font-style: normal;
		font-weight: 400;
		font-display: swap;
		src:
			url('/fonts/Leland.otf') format('opentype'),
			url('https://cdn.jsdelivr.net/gh/MuseScoreFonts/Leland@main/Leland.otf')
				format('opentype');
	}
</style>
