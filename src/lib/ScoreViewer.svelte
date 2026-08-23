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
		Search,
		Move,
		X,
		Check
	} from 'lucide-svelte';
	import { db } from './db';
	import type { ScoreItem, Stroke, SymbolStamp, TextNote } from './types';
	import {
		MUSICAL_SYMBOLS,
		SYMBOL_CATEGORIES,
		type SymbolCategory
	} from './musicSymbols';

	let { score, onBack }: { score: ScoreItem; onBack: () => void } = $props();
	let pdfDoc = $state<pdfjsLib.PDFDocumentProxy | null>(null),
		currentPage = $state(1),
		totalPages = $state(0);
	let loading = $state(true),
		loadError = $state(''),
		loadProgress = $state(0),
		loadingText = $state('Opening score…');
	let isDualPage = $state(false),
		fitMode = $state<'height' | 'width' | 'page'>('height'),
		zoomLevel = $state(1),
		filterMode = $state<'normal' | 'sepia' | 'dark'>('normal');
	let isAnnotationToolOpen = $state(false),
		activeTool = $state<
			'pen' | 'highlighter' | 'stamp' | 'text' | 'eraser' | 'move'
		>('pen');
	let penColor = $state('#ef4444'),
		penWidth = $state(3),
		selectedSymbol = $state(MUSICAL_SYMBOLS[0].symbol),
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
	let dragging: {
		type: 'text' | 'stamp';
		id: string;
		offsetX: number;
		offsetY: number;
	} | null = null;
	let leftPdfCanvas = $state<HTMLCanvasElement | null>(null),
		leftDrawCanvas = $state<HTMLCanvasElement | null>(null),
		rightPdfCanvas = $state<HTMLCanvasElement | null>(null),
		rightDrawCanvas = $state<HTMLCanvasElement | null>(null),
		mainContainerRef = $state<HTMLDivElement | null>(null);
	let saveTimers: Record<number, ReturnType<typeof setTimeout> | undefined> =
			{},
		renderToken = 0,
		pdfObjectUrl = '';
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

	onMount(() => {
		isDualPage = window.innerWidth >= 1024;
		pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
			'pdfjs-dist/build/pdf.worker.min.mjs',
			import.meta.url
		).toString();
		void openPdf();
		return () => {
			if (pdfObjectUrl) URL.revokeObjectURL(pdfObjectUrl);
			pdfDoc?.destroy();
		};
	});
	async function openPdf() {
		loading = true;
		loadError = '';
		loadProgress = 0;
		try {
			loadingText = 'Preparing score…';
			pdfObjectUrl = URL.createObjectURL(score.pdfBlob);
			const task = pdfjsLib.getDocument({
				url: pdfObjectUrl,
				rangeChunkSize: 1024 * 1024,
				disableAutoFetch: false,
				disableStream: false,
				isEvalSupported: false
			});
			task.onProgress = ({ loaded, total }) => {
				loadProgress = total
					? Math.min(100, Math.round((loaded / total) * 100))
					: Math.min(95, loadProgress + 5);
				loadingText = total
					? `Loading score… ${loadProgress}%`
					: 'Loading score…';
			};
			pdfDoc = await task.promise;
			totalPages = pdfDoc.numPages;
			loadProgress = 100;
			loadingText = `${totalPages} pages ready`;
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
			console.error(err);
			loadError =
				err instanceof Error ? err.message : 'The PDF could not be opened.';
		} finally {
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
	function history(p: number) {
		(historyStack[p] ||= []).push(snapshot(p));
		if (historyStack[p].length > 50) historyStack[p].shift();
		redoStack[p] = [];
	}
	function scheduleSave(p: number) {
		if (saveTimers[p]) clearTimeout(saveTimers[p]);
		saveTimers[p] = setTimeout(() => void saveToDb(p), 180);
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
		const next = redoStack[p].pop()!;
		(historyStack[p] ||= []).push(snapshot(p));
		annotations[p] = next.strokes;
		stamps[p] = next.stamps;
		notes[p] = next.notes;
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
		let scale = Math.max(0.25, Math.min(2.5, fit * zoomLevel));
		const maxPixels = 14_000_000;
		const estimated = base.width * scale * base.height * scale;
		if (estimated > maxPixels)
			scale = Math.sqrt(maxPixels / (base.width * base.height));
		const viewport = page.getViewport({ scale });
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
	function drawSegment(
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
		ctx.strokeStyle = tool === 'highlighter' ? 'rgba(250,204,21,.38)' : color;
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
				drawSegment(
					ctx,
					s.points[i - 1],
					s.points[i],
					s.tool,
					s.color,
					s.width
				);
		for (const s of stamps[p] || []) {
			ctx.save();
			ctx.font = `${s.fontSize}px Leland,serif`;
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
			ctx.textBaseline = 'middle';
			ctx.fillText(n.text, n.x, n.y);
			ctx.restore();
		}
	}
	function point(e: PointerEvent, c: HTMLCanvasElement) {
		const r = c.getBoundingClientRect();
		return { x: e.clientX - r.left, y: e.clientY - r.top };
	}
	function hitText(p: number, x: number, y: number) {
		const a = notes[p] || [];
		for (let i = a.length - 1; i >= 0; i--) {
			const n = a[i],
				w = Math.max(60, n.text.length * n.fontSize * 0.58);
			if (x >= n.x - 10 && x <= n.x + w && Math.abs(y - n.y) < n.fontSize + 14)
				return n;
		}
		return null;
	}
	function hitStamp(p: number, x: number, y: number) {
		const a = stamps[p] || [];
		for (let i = a.length - 1; i >= 0; i--) {
			const s = a[i];
			if (Math.hypot(x - s.x, y - s.y) < Math.max(28, s.fontSize * 0.6))
				return s;
		}
		return null;
	}
	function handlePointerDown(
		e: PointerEvent,
		p: number,
		canvas: HTMLCanvasElement
	) {
		if (!isAnnotationToolOpen) return;
		const { x, y } = point(e, canvas);
		if (activeTool === 'move') {
			const n = hitText(p, x, y),
				s = n ? null : hitStamp(p, x, y);
			if (n || s) {
				dragging = {
					type: n ? 'text' : 'stamp',
					id: (n || s)!.id,
					offsetX: x - (n || s)!.x,
					offsetY: y - (n || s)!.y
				};
				canvas.setPointerCapture(e.pointerId);
			}
			return;
		}
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
			openTextEditor(p, x, y);
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
		drawSegment(
			canvas.getContext('2d')!,
			{ x, y },
			{ x: x + 0.01, y: y + 0.01 },
			currentStroke.tool,
			currentStroke.color,
			currentStroke.width
		);
	}
	function handlePointerMove(
		e: PointerEvent,
		p: number,
		canvas: HTMLCanvasElement
	) {
		const { x, y } = point(e, canvas);
		if (dragging) {
			const item =
				dragging.type === 'text'
					? (notes[p] || []).find((n) => n.id === dragging!.id)
					: (stamps[p] || []).find((s) => s.id === dragging!.id);
			if (item) {
				item.x = x - dragging.offsetX;
				item.y = y - dragging.offsetY;
				redrawOverlay(p, canvas);
			}
			return;
		}
		if (!isDrawing || drawingPage !== p || !currentStroke) return;
		if (activeTool === 'eraser') {
			eraseAtPoint(x, y, p, canvas);
			return;
		}
		const pts = currentStroke.points,
			last = pts[pts.length - 1];
		if (Math.hypot(x - last.x, y - last.y) < 1.2) return;
		pts.push({ x, y });
		drawSegment(
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
		if (dragging) {
			dragging = null;
			if (canvas.hasPointerCapture(e.pointerId))
				canvas.releasePointerCapture(e.pointerId);
			scheduleSave(p);
			redrawOverlay(p, canvas);
			return;
		}
		if (!isDrawing || drawingPage !== p) return;
		isDrawing = false;
		if (canvas.hasPointerCapture(e.pointerId))
			canvas.releasePointerCapture(e.pointerId);
		if (
			activeTool !== 'eraser' &&
			currentStroke &&
			currentStroke.points.length > 1
		)
			(annotations[p] ||= []).push(currentStroke);
		currentStroke = null;
		redrawOverlay(p, canvas);
		scheduleSave(p);
	}
	function eraseAtPoint(
		x: number,
		y: number,
		p: number,
		canvas: HTMLCanvasElement
	) {
		const r = 24;
		annotations[p] = (annotations[p] || []).filter(
			(s) => !s.points.some((q) => Math.hypot(q.x - x, q.y - y) < r)
		);
		stamps[p] = (stamps[p] || []).filter(
			(s) => Math.hypot(s.x - x, s.y - y) > r + 8
		);
		notes[p] = (notes[p] || []).filter(
			(n) => Math.hypot(n.x - x, n.y - y) > r + 8
		);
		redrawOverlay(p, canvas);
	}
	let editingText = $state<{
		page: number;
		x: number;
		y: number;
		text: string;
		color: string;
		fontSize: number;
	} | null>(null);
	function openTextEditor(p: number, x: number, y: number) {
		editingText = { page: p, x, y, text: '', color: penColor, fontSize: 16 };
	}
	function confirmText() {
		if (!editingText || !editingText.text.trim()) {
			editingText = null;
			return;
		}
		const e = editingText;
		history(e.page);
		(notes[e.page] ||= []).push({
			id: crypto.randomUUID(),
			text: e.text.trim(),
			x: e.x,
			y: e.y,
			fontSize: e.fontSize,
			color: e.color
		});
		editingText = null;
		redrawOverlay(e.page, canvasForPage(e.page));
		scheduleSave(e.page);
	}
	function goToPage(n: number) {
		const page = isDualPage ? (n % 2 === 0 ? n - 1 : n) : n;
		if (page >= 1 && page <= totalPages) {
			currentPage = page;
			void renderPages();
		}
	}
	function handleKey(e: KeyboardEvent) {
		const target = e.target as HTMLElement;
		if (['INPUT', 'TEXTAREA'].includes(target.tagName)) return;
		if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
			e.preventDefault();
			undo(currentPage);
		} else if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
			e.preventDefault();
			redo(currentPage);
		} else if (e.key === 'ArrowRight' || e.key === 'PageDown')
			goToPage(currentPage + (isDualPage ? 2 : 1));
		else if (e.key === 'ArrowLeft' || e.key === 'PageUp')
			goToPage(currentPage - (isDualPage ? 2 : 1));
	}
</script>

<svelte:window onkeydown={handleKey} />
<div
	class="flex-1 flex flex-col relative bg-neutral-950 overflow-hidden select-none">
	<header
		class="flex items-center justify-between px-4 py-2.5 bg-neutral-900/90 backdrop-blur-md border-b border-neutral-800 z-20">
		<button
			onclick={onBack}
			class="flex items-center gap-2 text-neutral-400 hover:text-white px-3 py-1.5 rounded-lg hover:bg-neutral-800"
			><ArrowLeft size={18} /><span class="text-sm">Library</span></button>
		<div class="text-center truncate px-3">
			<h2 class="text-sm font-semibold text-neutral-200 truncate">
				{score.title}
			</h2>
			<p class="text-xs text-neutral-500">{score.composer}</p>
		</div>
		<div class="flex items-center gap-1.5">
			<div
				class="flex items-center bg-neutral-950 rounded-xl border border-neutral-800 p-1">
				<button
					onclick={() => {
						zoomLevel = Math.max(0.5, zoomLevel - 0.15);
						void renderPages();
					}}
					class="p-1.5 text-neutral-400"><ZoomOut size={16} /></button
				><span class="text-xs font-mono px-2 text-neutral-300"
					>{Math.round(zoomLevel * 100)}%</span
				><button
					onclick={() => {
						zoomLevel = Math.min(2.5, zoomLevel + 0.15);
						void renderPages();
					}}
					class="p-1.5 text-neutral-400"><ZoomIn size={16} /></button
				><button
					onclick={() => {
						zoomLevel = 1;
						fitMode = 'height';
						void renderPages();
					}}
					class="p-1.5 text-neutral-400 border-l border-neutral-800"
					><RotateCcw size={14} /></button>
			</div>
			<button
				onclick={() => {
					isDualPage = !isDualPage;
					void renderPages();
				}}
				class="p-2 rounded-xl border border-neutral-800 bg-neutral-950 text-neutral-400"
				>{#if isDualPage}<Columns size={16} />{:else}<Square
						size={16} />{/if}</button>
			<div
				class="flex items-center bg-neutral-950 rounded-xl border border-neutral-800 p-1">
				<button
					onclick={() => (filterMode = 'normal')}
					class="p-1.5 rounded-lg {filterMode === 'normal'
						? 'bg-neutral-800 text-white'
						: 'text-neutral-500'}"><Sun size={15} /></button
				><button
					onclick={() => (filterMode = 'sepia')}
					class="p-1.5 rounded-lg {filterMode === 'sepia'
						? 'bg-amber-900/50 text-amber-200'
						: 'text-neutral-500'}"><BookOpen size={15} /></button
				><button
					onclick={() => (filterMode = 'dark')}
					class="p-1.5 rounded-lg {filterMode === 'dark'
						? 'bg-neutral-800 text-white'
						: 'text-neutral-500'}"><Moon size={15} /></button>
			</div>
		</div>
	</header>
	<div
		bind:this={mainContainerRef}
		class="flex-1 overflow-auto flex justify-center items-center p-2 relative">
		<button
			disabled={currentPage <= 1}
			onclick={() => goToPage(currentPage - (isDualPage ? 2 : 1))}
			class="absolute left-0 top-0 bottom-0 w-16 z-10 flex items-center justify-center opacity-0 hover:opacity-100 text-white"
			><ChevronLeft size={34} /></button
		><button
			disabled={currentPage >= totalPages}
			onclick={() => goToPage(currentPage + (isDualPage ? 2 : 1))}
			class="absolute right-0 top-0 bottom-0 w-16 z-10 flex items-center justify-center opacity-0 hover:opacity-100 text-white"
			><ChevronRight size={34} /></button
		>{#if loading}<div class="w-72 text-center text-neutral-500">
				<div
					class="w-8 h-8 mx-auto rounded-full border-2 border-neutral-700 border-t-blue-400 animate-spin">
				</div>
				<div class="text-sm mt-3">{loadingText}</div>
				{#if loadProgress > 0}<div
						class="h-1.5 bg-neutral-800 rounded-full mt-3 overflow-hidden">
						<div
							class="h-full bg-blue-500 transition-all"
							style="width:{loadProgress}%">
						</div>
					</div>{/if}
			</div>{:else if loadError}<div class="max-w-md text-center">
				<div class="text-red-400 font-semibold mb-2">
					Could not open this score
				</div>
				<p class="text-sm text-neutral-500 mb-4 break-words">{loadError}</p>
				<button
					onclick={openPdf}
					class="px-4 py-2 bg-neutral-800 rounded-xl text-sm">Try again</button>
			</div>{:else}<div class="flex gap-4 justify-center items-center z-0">
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
							leftDrawCanvas &&
							handlePointerDown(e, currentPage, leftDrawCanvas)}
						onpointermove={(e) =>
							leftDrawCanvas &&
							handlePointerMove(e, currentPage, leftDrawCanvas)}
						onpointerup={(e) =>
							leftDrawCanvas && handlePointerUp(e, currentPage, leftDrawCanvas)}
						onpointercancel={(e) =>
							leftDrawCanvas && handlePointerUp(e, currentPage, leftDrawCanvas)}
						class="absolute top-0 left-0 touch-none {isAnnotationToolOpen
							? ''
							: 'pointer-events-none'}"></canvas>
				</div>
				{#if isDualPage && currentPage + 1 <= totalPages}<div
						class="relative shadow-2xl rounded overflow-hidden bg-white">
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
								? ''
								: 'pointer-events-none'}"></canvas>
					</div>{/if}
			</div>{/if}
	</div>
	{#if isAnnotationToolOpen}<div
			class="absolute top-14 left-1/2 -translate-x-1/2 z-30 bg-neutral-900/95 backdrop-blur-xl border border-neutral-700 p-2.5 rounded-2xl shadow-2xl w-[min(820px,calc(100vw-24px))]">
			<div class="flex items-center gap-1.5 overflow-x-auto">
				<button
					title="Pen"
					onclick={() => (activeTool = 'pen')}
					class="tool {activeTool === 'pen' ? 'active-blue' : ''}"
					><Pencil size={18} /></button
				><button
					title="Highlighter"
					onclick={() => (activeTool = 'highlighter')}
					class="tool {activeTool === 'highlighter' ? 'active-yellow' : ''}"
					><Highlighter size={18} /></button
				><button
					title="Move text and symbols"
					onclick={() => (activeTool = 'move')}
					class="tool {activeTool === 'move' ? 'active-purple' : ''}"
					><Move size={18} /></button
				><button
					title="Musical symbol"
					onclick={() => (activeTool = 'stamp')}
					class="tool {activeTool === 'stamp' ? 'active-purple' : ''}"
					><Music2 size={18} /></button
				><button
					title="Text"
					onclick={() => (activeTool = 'text')}
					class="tool {activeTool === 'text' ? 'active-green' : ''}"
					><Type size={18} /></button
				><button
					title="Eraser"
					onclick={() => (activeTool = 'eraser')}
					class="tool {activeTool === 'eraser' ? 'active-gray' : ''}"
					><Eraser size={18} /></button
				><span class="h-5 w-px bg-neutral-800 mx-1"></span
				>{#each QUICK_COLORS as c}<button
						onclick={() => (penColor = c)}
						aria-label={c}
						style="background:{c}"
						class="w-5 h-5 rounded-full border border-neutral-700 {penColor ===
						c
							? 'ring-2 ring-blue-500 scale-110'
							: ''}"></button
					>{/each}<span class="h-5 w-px bg-neutral-800 mx-1"></span><button
					onclick={() => undo(currentPage)}
					class="tool"><Undo size={16} /></button
				><button onclick={() => redo(currentPage)} class="tool"
					><Redo size={16} /></button
				><button
					onclick={() => {
						history(currentPage);
						annotations[currentPage] = [];
						stamps[currentPage] = [];
						notes[currentPage] = [];
						redrawOverlay(currentPage, canvasForPage(currentPage));
						scheduleSave(currentPage);
					}}
					class="tool hover:text-red-400"><Trash2 size={16} /></button>
			</div>
			{#if activeTool === 'stamp'}<div
					class="border-t border-neutral-800 mt-2 pt-2 space-y-2">
					<div class="relative">
						<Search
							size={14}
							class="absolute left-2.5 top-1/2 -translate-y-1/2 text-neutral-500" /><input
							bind:value={symbolSearch}
							placeholder="Search musical symbols…"
							class="w-full bg-neutral-950 border border-neutral-800 rounded-lg pl-8 pr-3 py-1.5 text-xs outline-none" />
					</div>
					<div class="flex gap-1 overflow-x-auto">
						{#each SYMBOL_CATEGORIES as c}<button
								onclick={() => (symbolCategory = c)}
								class="px-2.5 py-1 rounded-lg text-[11px] whitespace-nowrap {symbolCategory ===
								c
									? 'bg-purple-600/25 text-purple-200 border border-purple-500/50'
									: 'text-neutral-400 bg-neutral-950 border border-neutral-800'}"
								>{c}</button
							>{/each}
					</div>
					<div
						class="grid grid-cols-6 sm:grid-cols-10 gap-1.5 max-h-28 overflow-y-auto">
						{#each filteredSymbols as s}<button
								onclick={() => (selectedSymbol = s.symbol)}
								title={s.label}
								class="aspect-square rounded-lg border flex flex-col items-center justify-center {selectedSymbol ===
								s.symbol
									? 'bg-purple-600/25 border-purple-500'
									: 'bg-neutral-950 border-neutral-800'}"
								><span
									class="text-2xl leading-none"
									style="font-family:Leland,serif">{s.symbol}</span
								><span
									class="text-[8px] text-neutral-500 truncate w-full text-center px-1"
									>{s.label}</span
								></button
							>{/each}
					</div>
				</div>{/if}{#if activeTool === 'move'}<div
					class="border-t border-neutral-800 mt-2 pt-2 text-xs text-neutral-500">
					Drag a text note or musical symbol to move it.
				</div>{/if}
		</div>{/if}
	{#if editingText}<div
			class="absolute inset-0 z-40 flex items-center justify-center bg-black/35">
			<div
				class="w-[min(420px,calc(100vw-32px))] bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl p-4">
				<div class="flex items-center justify-between mb-3">
					<h3 class="font-semibold text-neutral-100">Add rehearsal note</h3>
					<button onclick={() => (editingText = null)} class="text-neutral-500"
						><X size={18} /></button>
				</div>
				<textarea
					autofocus
					bind:value={editingText.text}
					placeholder="e.g. More bow here…"
					rows="4"
					class="w-full resize-none bg-neutral-950 border border-neutral-800 rounded-xl p-3 text-sm outline-none focus:border-blue-500"
				></textarea>
				<div class="flex justify-end gap-2 mt-3">
					<button
						onclick={() => (editingText = null)}
						class="px-3 py-2 rounded-xl text-sm text-neutral-400">Cancel</button
					><button
						onclick={confirmText}
						class="px-3 py-2 rounded-xl bg-blue-600 text-white text-sm flex items-center gap-2"
						><Check size={15} />Add note</button>
				</div>
			</div>
		</div>{/if}
	<footer class="p-3 flex justify-center z-20">
		<div
			class="bg-neutral-900/90 backdrop-blur-xl border border-neutral-800 px-5 py-2 rounded-2xl shadow-2xl flex items-center gap-5">
			<button
				disabled={currentPage <= 1}
				onclick={() => goToPage(currentPage - (isDualPage ? 2 : 1))}
				class="p-2 bg-neutral-800 disabled:opacity-30 rounded-xl"
				><ChevronLeft size={18} /></button
			><span class="text-xs font-semibold text-neutral-300 min-w-20 text-center"
				>{currentPage}{isDualPage && currentPage + 1 <= totalPages
					? `–${currentPage + 1}`
					: ''} / {totalPages}</span
			><button
				disabled={currentPage >= totalPages}
				onclick={() => goToPage(currentPage + (isDualPage ? 2 : 1))}
				class="p-2 bg-neutral-800 disabled:opacity-30 rounded-xl"
				><ChevronRight size={18} /></button
			><span class="h-5 w-px bg-neutral-800"></span><button
				onclick={() => (isAnnotationToolOpen = !isAnnotationToolOpen)}
				class="px-4 py-2 rounded-xl text-xs font-semibold {isAnnotationToolOpen
					? 'bg-blue-600 text-white'
					: 'bg-neutral-800 text-neutral-300'}"
				><Pencil size={15} class="inline mr-1.5" />Annotate</button>
		</div>
	</footer>
</div>

<style>
	@font-face {
		font-family: 'Leland';
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
		color: #fff;
	}
	.active-blue {
		background: #2563eb !important;
		color: #fff;
	}
	.active-yellow {
		background: #ca8a04 !important;
		color: #fff;
	}
	.active-purple {
		background: #9333ea !important;
		color: #fff;
	}
	.active-green {
		background: #059669 !important;
		color: #fff;
	}
	.active-gray {
		background: #404040 !important;
		color: #fff;
	}
</style>
