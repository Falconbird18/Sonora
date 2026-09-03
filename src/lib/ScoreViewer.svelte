<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { loadAnnotations, saveAnnotation, flushAnnotationSaves, requestPersistentStorage } from './annotationStore';
	import type { ScoreItem, Stroke, Point, SymbolStamp, TextNote } from './types';
	import { MUSIC_SYMBOLS, MUSIC_SYMBOL_CATEGORIES } from './musicSymbols';
	import { openPdfSource, closePdf, MAX_CANVAS_PIXELS } from './pdfUtils';
	import type { PdfDocumentProxy, PdfPageProxy, PdfRenderTask } from './pdfUtils';
	import {
		ArrowLeft,
		ArrowUpRight,
		Bookmark,
		BookmarkCheck,
		ChevronLeft,
		ChevronRight,
		Columns2,
		Download,
		Eraser,
		Eye,
		EyeOff,
		Highlighter,
		Maximize2,
		Minimize2,
		Minus,
		MousePointer2,
		Music2,
		PenTool,
		Printer,
		Redo2,
		Search,
		Settings2,
		Type,
		Undo2,
		X,
		ZoomIn,
		ZoomOut,
		Pencil,
		Check,
		Scan,
		StretchHorizontal
	} from '@lucide/svelte';
	let { score, onClose }: { score: ScoreItem; onClose: () => void } = $props();

	type Tool = 'move' | 'pen' | 'highlighter' | 'eraser' | 'line' | 'arrow' | 'symbol' | 'text';
	type Fit = 'page' | 'width';
	type Snapshot = { strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[] };
	type TextEditor = { page: number; x: number; y: number; text: string; id?: string };

	let pdf = $state<PdfDocumentProxy | null>(null);
	let openedPdf: Awaited<ReturnType<typeof openPdfSource>> | null = null;
	let page = $state(1);
	let pageInput = $state('1');
	let zoom = $state(1);
	let fit = $state<Fit>('page');
	let dual = $state(false);
	let autoLayout = $state(true);
	let zoomTimer: ReturnType<typeof setTimeout> | undefined;
	let pageTransition = $state(false);
	let loading = $state(false);
	let loadingText = $state('Opening score…');
	let error = $state('');
	let controls = $state(false);
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
	let recentSymbols = $state<string[]>([]);
	let textSize = $state(18);
	let textEditor = $state<TextEditor | null>(null);
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
	let tasks: PdfRenderTask[] = [];
	let resizeTimer: ReturnType<typeof setTimeout> | undefined;
	let prefetchTimer: ReturnType<typeof setTimeout> | undefined;
	let saveTimers = new Map<number, ReturnType<typeof setTimeout>>();
	let drawing: {
		page: number;
		canvas: HTMLCanvasElement;
		pointerId: number;
		stroke?: Stroke;
		raf?: number;
	} | null = null;
	let hasPainted = $state(false);
	let closed = false;
	let isFullscreen = $state(false);

	async function flushPendingAnnotations() {
		const pages = [...saveTimers.keys()];
		for (const number of pages) {
			const timer = saveTimers.get(number);
			if (timer) clearTimeout(timer);
			saveTimers.delete(number);
			await saveAnnotations(number);
		}
		await flushAnnotationSaves();
	}

	const prefs = $derived(`sonora-viewer-${score.id}`);
	const colors = ['#c2410c', '#2563eb', '#15803d', '#a16207', '#7e22ce', '#111827', '#ffffff'];
	const visiblePages = $derived(
		pdf ? (dual ? [page, Math.min(pdf.numPages, page + 1)] : [page]) : [page]
	);
	const filteredSymbols = $derived(
		MUSIC_SYMBOLS.filter(
			(s) =>
				s.category === symbolCategory &&
				(!symbolSearch.trim() || s.name.toLowerCase().includes(symbolSearch.toLowerCase()))
		)
	);
	const recentSymbolObjects = $derived(
		recentSymbols
			.map((id) => MUSIC_SYMBOLS.find((s) => s.id === id))
			.filter((s): s is (typeof MUSIC_SYMBOLS)[number] => !!s)
	);
	const canUndo = $derived((historyIndex[page] ?? 0) > 0);
	const canRedo = $derived((historyIndex[page] ?? 0) < (histories[page]?.length ?? 1) - 1);

	onMount(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(prefs) || '{}');
			bookmarked = !!saved.bookmarked;
			autoLayout = saved.autoLayout !== false;
			if (typeof saved.dual === 'boolean' && !autoLayout) {
				dual = saved.dual;
			} else {
				dual = window.matchMedia('(orientation: landscape)').matches && window.innerWidth >= 720;
			}
			zoom = typeof saved.zoom === 'number' ? saved.zoom : 1;
			fit = saved.fit === 'width' ? 'width' : 'page';
			annotationsVisible = saved.annotationsVisible !== false;
			recentSymbols = Array.isArray(saved.recentSymbols) ? saved.recentSymbols : [];
			if (typeof saved.page === 'number' && saved.page > 0) {
				page = saved.page;
				pageInput = String(saved.page);
			}
		} catch {}
		requestPersistentStorage();
		void load();
		const key = (event: KeyboardEvent) => {
			if (textEditor) {
				if (event.key === 'Escape') {
					event.preventDefault();
					cancelText();
				}
				return;
			}
			if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement)
				return;
			if (event.key === 'ArrowRight' || event.key === 'PageDown' || event.key === ' ') {
				event.preventDefault();
				next();
			} else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
				event.preventDefault();
				previous();
			} else if (event.key === '+' || event.key === '=') setZoom(zoom + 0.1);
			else if (event.key === '-') setZoom(zoom - 0.1);
			else if (event.key.toLowerCase() === 'f') {
				event.preventDefault();
				reading ? exitReading() : enterReading();
			} else if (event.key.toLowerCase() === 'p') choose('pen');
			else if (event.key.toLowerCase() === 'h') choose('highlighter');
			else if (event.key.toLowerCase() === 'e') choose('eraser');
			else if (event.key.toLowerCase() === 's') choose('symbol');
			else if (event.key.toLowerCase() === 't') choose('text');
			else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
				event.preventDefault();
				undo();
			} else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
				event.preventDefault();
				redo();
			} else if (event.key === 'Escape') {
				if (settingsOpen || searchOpen || controls || reading) {
					settingsOpen = false;
					searchOpen = false;
					controls = false;
					if (reading) exitReading();
					choose('move');
				} else {
					void leave();
				}
			}
		};
		const onFullscreen = () => {
			isFullscreen = !!document.fullscreenElement;
		};
		window.addEventListener('keydown', key);
		document.addEventListener('fullscreenchange', onFullscreen);
		const observer = new ResizeObserver(() => {
			clearTimeout(resizeTimer);
			resizeTimer = setTimeout(() => void render({ quiet: true }), 100);
		});
		if (host) observer.observe(host);
		return () => {
			closed = true;
			window.removeEventListener('keydown', key);
			document.removeEventListener('fullscreenchange', onFullscreen);
			observer.disconnect();
			clearTimeout(resizeTimer);
			clearTimeout(prefetchTimer);
			clearTimeout(zoomTimer);
			cancelRender();
			void flushPendingAnnotations();
			releaseCanvases();
			if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
			void destroyDocument();
		};
	});

	async function load() {
		loading = true;
		error = '';
		hasPainted = false;
		loadingText = 'Opening score…';
		try {
			await destroyDocument();
			const hasUrl = !!(score.pdfUrl && score.pdfUrl.length > 0);
			const hasBlob = !!(score.pdfBlob && score.pdfBlob.size > 0);
			const hasPath = !!(score.nativePath && score.nativePath.length > 0);
			if (!hasUrl && !hasBlob && !hasPath) {
				throw new Error('PDF data is missing. Try refreshing the library and open again.');
			}
			const opened = await openPdfSource({
				url: score.pdfUrl,
				blob: score.pdfBlob,
				nativePath: score.nativePath
			});
			if (closed) {
				await closePdf(opened);
				return;
			}
			pdf = opened.document;
			openedPdf = opened;
			if (page > pdf.numPages) {
				page = 1;
				pageInput = '1';
			}
			const records = await loadAnnotations(score.id);
			for (const record of records) {
				strokes[record.pageNum] = record.strokes || [];
				stamps[record.pageNum] = record.stamps || [];
				notes[record.pageNum] = record.notes || [];
				histories[record.pageNum] = [
					{
						strokes: structuredClone(record.strokes || []),
						stamps: structuredClone(record.stamps || []),
						notes: structuredClone(record.notes || [])
					}
				];
				historyIndex[record.pageNum] = 0;
			}
			await tick();
			ensureHistory(page);
			await render();
		} catch (reason) {
			console.error('PDF load failed', reason);
			error =
				reason instanceof Error && reason.message.includes('missing')
					? reason.message
					: 'This PDF could not be opened by the renderer. Try refreshing the library.';
		} finally {
			if (!closed) loading = false;
		}
	}

	async function destroyDocument() {
		cancelRender();
		const opened = openedPdf;
		openedPdf = null;
		pdf = null;
		if (opened) await closePdf(opened);
	}

	function releaseCanvases() {
		for (const canvas of [leftPdf, rightPdf, leftInk, rightInk]) {
			if (!canvas) continue;
			try {
				canvas.getContext('2d')?.clearRect(0, 0, canvas.width, canvas.height);
			} catch {}
			canvas.width = 0;
			canvas.height = 0;
		}
	}

	async function leave() {
		await flushPendingAnnotations();
		closed = true;
		if (document.fullscreenElement) {
			try {
				await document.exitFullscreen();
			} catch {}
		}
		releaseCanvases();
		onClose();
	}

	function cancelRender() {
		for (const task of tasks) {
			try {
				task.cancel();
			} catch {}
		}
		tasks = [];
	}

	async function render(opts?: { quiet?: boolean }) {
		if (!pdf || !host || closed) return;
		cancelRender();
		const current = ++generation;
		if (!opts?.quiet || !hasPainted) {
			loading = true;
			loadingText = dual ? 'Rendering pages…' : 'Rendering page…';
		}
		error = '';
		try {
			if (autoLayout) {
				const landscape = window.matchMedia('(orientation: landscape)').matches;
				const wideEnough = host.clientWidth >= 720;
				const nextDual = landscape && wideEnough;
				if (nextDual !== dual) {
					dual = nextDual;
					persistPrefs();
				}
			} else if (host.clientWidth < 720) {
				dual = false;
			}
			for (let index = 0; index < visiblePages.length; index++) {
				await renderPage(visiblePages[index], index, current);
				if (current !== generation) return;
			}
			if (current === generation) hasPainted = true;
		} catch (reason) {
			if (
				!(reason instanceof Error && reason.name === 'RenderingCancelledException') &&
				current === generation
			) {
				console.error('PDF render failed', reason);
				error = 'This page could not be rendered at the current size. Try Fit Page or reduce zoom.';
			}
		} finally {
			if (current === generation) loading = false;
		}
	}

	async function renderPage(number: number, index: number, current: number) {
		if (!pdf || !host) return;
		const pdfPage = await pdf.getPage(number);
		if (current !== generation) return;
		const base = pdfPage.getViewport({ scale: 1 });
		const availableWidth = Math.max(
			280,
			dual ? (host.clientWidth - 92) / 2 : host.clientWidth - 58
		);
		const availableHeight = Math.max(280, host.clientHeight - 72);
		const desired =
			(fit === 'width'
				? availableWidth / base.width
				: Math.min(availableWidth / base.width, availableHeight / base.height)) * zoom;
		const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
		const area = Math.max(1, base.width * base.height);
		const safeScale = Math.sqrt(MAX_CANVAS_PIXELS / (area * dpr * dpr));
		const scale = Math.max(0.18, Math.min(2.4, desired, safeScale));
		await paintPage(pdfPage, number, index, scale, dpr, current);
	}

	async function paintPage(
		pdfPage: PdfPageProxy,
		number: number,
		index: number,
		scale: number,
		dpr: number,
		current: number
	) {
		const viewport = pdfPage.getViewport({ scale });
		const widthPx = Math.ceil(viewport.width);
		const heightPx = Math.ceil(viewport.height);
		const canvasW = Math.ceil(widthPx * dpr);
		const canvasH = Math.ceil(heightPx * dpr);
		if (canvasW * canvasH > MAX_CANVAS_PIXELS) throw new Error('Canvas exceeds safe pixel budget');
		const pdfCanvas = index === 0 ? leftPdf : rightPdf;
		const inkCanvas = index === 0 ? leftInk : rightInk;
		if (!pdfCanvas || !inkCanvas) return;
		for (const canvas of [pdfCanvas, inkCanvas]) {
			canvas.width = canvasW;
			canvas.height = canvasH;
			canvas.style.width = `${widthPx}px`;
			canvas.style.height = `${heightPx}px`;
		}
		const context = pdfCanvas.getContext('2d', { alpha: false });
		if (!context) throw new Error('2D context unavailable');
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.fillStyle = '#fff';
		context.fillRect(0, 0, widthPx, heightPx);
		const task = pdfPage.render({ canvas: pdfCanvas, canvasContext: context, viewport });
		tasks.push(task);
		await task.promise;
		if (current === generation) {
			redraw(number, inkCanvas);
			schedulePrefetch();
		}
	}

	function schedulePrefetch() {
		clearTimeout(prefetchTimer);
		prefetchTimer = setTimeout(() => {
			if (!pdf || closed) return;
			const upcoming = [
				page + (dual ? 2 : 1),
				page + (dual ? 4 : 2),
				Math.max(1, page - 1),
				Math.max(1, page - (dual ? 2 : 1))
			];
			for (const number of upcoming) {
				if (number >= 1 && number <= pdf.numPages) void pdf.getPage(number).catch(() => {});
			}
		}, 60);
	}

	function position(event: PointerEvent, canvas: HTMLCanvasElement): Point {
		const rect = canvas.getBoundingClientRect();
		return {
			x: Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width)),
			y: Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height)),
			pressure: event.pressure || 0.5
		};
	}
	function pointToCanvas(point: Point, canvas: HTMLCanvasElement) {
		const rect = canvas.getBoundingClientRect();
		return { x: point.x * rect.width, y: point.y * rect.height };
	}
	function choose(nextTool: Tool) {
		tool = nextTool;
		if (nextTool === 'move') textEditor = null;
	}