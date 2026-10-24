<script lang="ts">
	import {
		handwritingImage,
		recognizeHandwriting,
		loadHandwritingPause
	} from './handwriting';
	import {
		prepareRecognition,
		type RecognitionMode
	} from './recognition/client';
	import { scoreRasterScale, scoreRasterKey } from './scoreRaster';
	import { formatComposer } from './composerDisplay';
	import { onMount, tick, untrack } from 'svelte';
	import {
		loadAnnotations,
		saveAnnotation,
		flushAnnotationSaves,
		requestPersistentStorage
	} from './annotationStore';
	import type {
		ScoreItem,
		Stroke,
		Point,
		SymbolStamp,
		TextNote
	} from './types';
	import { MUSIC_SYMBOLS, MUSIC_SYMBOL_CATEGORIES } from './musicSymbols';
	import { openPdfSource, closePdf, MAX_CANVAS_PIXELS } from './pdfUtils';
	import { acquireScreenWakeLock, releaseScreenWakeLock } from './wakeLock';
	import { settings } from './settingsStore';
	import HandwritingSetup from './ui/HandwritingSetup.svelte';
	import SettingsPanel from './ui/SettingsPanel.svelte';
	import PracticeTools from './ui/PracticeTools.svelte';
	import AnnotationLayersPanel from './ui/AnnotationLayersPanel.svelte';
	import { db } from './db';
	import { replaceLayerMarks, recoverLayers } from './annotationLayers';
	import type { AnnotationLayer } from './types';
	import { get } from 'svelte/store';
	import type {
		PdfDocumentProxy,
		PdfPageProxy,
		PdfRenderTask
	} from './pdfUtils';
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
		Highlighter,
		Maximize2,
		Minimize2,
		Minus,
		Music2,
		PenTool,
		PenLine,
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
		Layers,
		Metronome,
		AudioLines,
		PanelTopClose,
		PanelTopOpen,
		Scan,
		StretchHorizontal,
		Eye,
		EyeOff
	} from '@lucide/svelte';
	let {
		score,
		onClose,
		sequenceLabel = '',
		onPreviousScore,
		onNextScore
	}: {
		score: ScoreItem;
		onClose: () => void;
		sequenceLabel?: string;
		onPreviousScore?: () => Promise<void>;
		onNextScore?: () => Promise<void>;
	} = $props();
	let switchingScore = $state(false);
	async function switchProgram(action?: () => Promise<void>) {
		if (!action || switchingScore) return;
		switchingScore = true;
		try {
			await flushPendingAnnotations();
			await action();
		} finally {
			switchingScore = false;
		}
	}

	type Tool =
		| 'pan'
		| 'pen'
		| 'handwriting'
		| 'highlighter'
		| 'eraser'
		| 'line'
		| 'arrow'
		| 'symbol'
		| 'text';
	type Fit = 'page' | 'width';
	type Snapshot = {
		strokes: Stroke[];
		stamps: SymbolStamp[];
		notes: TextNote[];
	};
	type TextEditor = {
		page: number;
		x: number;
		y: number;
		text: string;
		id?: string;
		screenX?: number;
		screenY?: number;
	};
	type PageBitmap = {
		index: number;
		number: number;
		widthPx: number;
		heightPx: number;
		canvasW: number;
		canvasH: number;
		offscreen: HTMLCanvasElement | ImageBitmap;
	};

	let pdf = $state<PdfDocumentProxy | null>(null);
	let openedPdf: Awaited<ReturnType<typeof openPdfSource>> | null = null;
	let page = $state(1);
	let pageInput = $state('1');
	let zoom = $state(1);
	let fit = $state<Fit>('page');
	let dual = $state(false);
	let autoLayout = $state(true);
	let keepAwake = $state(true);
	let wakeLockActive = $state(false);
	/** @deprecated layout zoom is applied via CSS transform using `zoom` */
	let visualScale = $state(1);
	let renderedZoom = 1;
	let zoomRaf = 0;
	let zoomPending: number | null = null;
	let zoomFocusX = 0;
	let zoomFocusY = 0;
	let needsCenter = true;
	let zoomTimer: ReturnType<typeof setTimeout> | undefined;
	let pageTransition = $state(false);
	let loading = $state(false);
	let loadingText = $state('Opening score…');
	let error = $state('');
	let controls = $state(false);
	let reading = $state(get(settings).viewerMode === 'reading');
	let practicePanel = $state<'metronome' | 'tuner' | null>(null);
	let practiceState = $state({ metronome: false, tuner: false });
	function togglePractice(panel: 'metronome' | 'tuner') {
		practicePanel = practicePanel === panel ? null : panel;
		layersOpen = false;
		searchOpen = false;
	}
	let searchOpen = $state(false);
	let searchText = $state('');
	let searchStatus = $state('');
	let settingsOpen = $state(false);
	let bookmarked = $state(false);
	let annotationsVisible = $state(true);
	let layers = $state<AnnotationLayer[]>([
		{ id: 'default', name: 'Annotations', visible: true }
	]);
	let activeLayer = $state('default');
	let layersOpen = $state(false);
	let layerError = $state('');
	function historyKey(page: number) {
		return `${page}:${activeLayer}`;
	}
	function editable(mark: { layerId?: string }) {
		return (
			(mark.layerId || 'default') === activeLayer &&
			layers.some((l) => l.id === activeLayer && l.visible)
		);
	}
	let layerWrites: Promise<unknown> = Promise.resolve();
	function saveLayers() {
		layers = layers.map((l) => ({
			...l,
			name: l.name.trim() || 'Untitled layer'
		}));
		const snapshot = $state.snapshot(layers),
			id = score.id;
		layerWrites = layerWrites
			.catch(() => {})
			.then(() => db.scores.update(id, { annotationLayers: snapshot }))
			.catch((e) => {
				layerError = `Could not save layers: ${String(e)}`;
			});
		redraw(visiblePages[0], leftInk);
		if (visiblePages[1]) redraw(visiblePages[1], rightInk);
	}
	function addLayer() {
		const layer = {
			id: crypto.randomUUID(),
			name: `Layer ${layers.length + 1}`,
			visible: true
		};
		layers = [...layers, layer];
		activeLayer = layer.id;
		saveLayers();
	}
	function moveLayer(index: number, direction: number) {
		const target = index + direction;
		if (target < 0 || target >= layers.length) return;
		const next = [...layers];
		[next[index], next[target]] = [next[target], next[index]];
		layers = next;
		saveLayers();
	}

	let isDrawing = $state(false);
	let tool = $state<Tool>('pan');
	let annotating = $derived(controls && tool !== 'pan' && !reading);
	const strokeTool = $derived(
		tool === 'pen' ||
			tool === 'handwriting' ||
			tool === 'highlighter' ||
			tool === 'line' ||
			tool === 'arrow'
	);
	const showToolOptions = $derived(
		annotating && (strokeTool || tool === 'eraser')
	);
	const paletteAway = $derived(isDrawing);
	let color = $state('#111827');
	let width = $state(3);
	let selectedSymbol = $state(MUSIC_SYMBOLS[0]);
	let symbolCategory = $state<
		'Recent' | (typeof MUSIC_SYMBOL_CATEGORIES)[number]
	>('Recent');
	let symbolSearch = $state('');
	let symbolSize = $state(34);
	let recentSymbols = $state<string[]>([]);
	let cursorScreen = $state<{ x: number; y: number } | null>(null);
	/** View pan offset in CSS pixels (transform-based for smooth dragging). */
	let panX = $state(0);
	let panY = $state(0);
	type PanDrag = {
		pointerId: number;
		lastX: number;
		lastY: number;
		lastT: number;
	};

	let panDrag = $state<PanDrag | null>(null);
	let panVx = 0;
	let panVy = 0;
	let panMomentumRaf = 0;
	/** Active two-finger pinch-to-zoom (tablet). */
	type PinchState = {
		lastDist: number;
		lastMidX: number;
		lastMidY: number;
	};
	let pinch: PinchState | null = null;
	let textSize = $state(18);
	let textEditor = $state<TextEditor | null>(null);
	let textDraft = $state('');
	let draggingAnnot: {
		kind: 'stamp' | 'note';
		page: number;
		id: string;
		canvas: HTMLCanvasElement;
		pointerId: number;
	} | null = null;
	let strokes = $state<Record<number, Stroke[]>>({});
	let stamps = $state<Record<number, SymbolStamp[]>>({});
	let notes = $state<Record<number, TextNote[]>>({});
	let histories = $state<Record<string, Snapshot[]>>({});
	let historyIndex = $state<Record<string, number>>({});
	let host = $state<HTMLElement | null>(null);
	let workspace = $state<HTMLElement | null>(null);
	let leftPdf = $state<HTMLCanvasElement | null>(null);
	let rightPdf = $state<HTMLCanvasElement | null>(null);
	let leftInk = $state<HTMLCanvasElement | null>(null);
	let rightInk = $state<HTMLCanvasElement | null>(null);
	let generation = 0;
	let tasks: Array<{ task: PdfRenderTask; number: number }> = [];
	const pendingPages = new Map<
		string,
		{ task: PdfRenderTask; promise: Promise<PageBitmap | null> }
	>();
	/** LRU cache of fully rendered page bitmaps keyed by `page@renderScale`. */
	const pageCache = new Map<string, PageBitmap>();
	const MAX_PAGE_CACHE = 20;
	// RGBA canvases: bound backing storage as well as the number of pages.
	const MAX_CACHE_PIXELS = 48_000_000;
	function releaseBitmap(image: HTMLCanvasElement | ImageBitmap) {
		if ('close' in image) image.close();
		else {
			image.width = 0;
			image.height = 0;
		}
	}
	function touchCache(key: string, bmp: PageBitmap) {
		if (pageCache.has(key)) pageCache.delete(key);
		pageCache.set(key, bmp);
		let pixels = [...pageCache.values()].reduce(
			(sum, page) => sum + page.canvasW * page.canvasH,
			0
		);
		while (pageCache.size > MAX_PAGE_CACHE || pixels > MAX_CACHE_PIXELS) {
			const oldest = pageCache.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			const old = pageCache.get(oldest);
			if (old) pixels -= old.canvasW * old.canvasH;
			pageCache.delete(oldest);
			// Help GC release large canvases
			if (old?.offscreen) {
				releaseBitmap(old.offscreen);
			}
		}
	}
	function clearPageCache() {
		for (const bmp of pageCache.values()) {
			if (bmp.offscreen) {
				releaseBitmap(bmp.offscreen);
			}
		}
		pageCache.clear();
	}
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
	/** True while a stroke/erase is in progress — palette steps aside. */
	/** Symbol drawer collapsed to a thin strip after placement. */
	let symbolSheetCollapsed = $state(false);
	let hasPainted = $state(false);
	let closed = false;
	let isFullscreen = $state(false);

	async function flushPendingAnnotations() {
		cancelHandwriting();
		// Cancel any debounced timers and force-write those pages first.
		const pendingPages = [...saveTimers.keys()];
		for (const number of pendingPages) {
			const timer = saveTimers.get(number);
			if (timer) clearTimeout(timer);
			saveTimers.delete(number);
			await saveAnnotations(number);
		}
		// Also persist any page that already has annotation data in memory,
		// so a close that races the debounce cannot drop work.
		const known = new Set<number>([
			...Object.keys(strokes).map(Number),
			...Object.keys(stamps).map(Number),
			...Object.keys(notes).map(Number)
		]);
		for (const number of known) {
			if (pendingPages.includes(number)) continue;
			const hasData =
				(strokes[number]?.length ?? 0) > 0 ||
				(stamps[number]?.length ?? 0) > 0 ||
				(notes[number]?.length ?? 0) > 0;
			if (hasData) await saveAnnotations(number);
		}
		await flushAnnotationSaves();
		await layerWrites;
	}

	const prefs = $derived(`sonora-viewer-${score.id}`);
	const colors = [
		'#c2410c',
		'#111827',
		'#2563eb',
		'#15803d',
		'#a16207',
		'#7e22ce',
		'#ffffff'
	];
	const primaryColors = colors.slice(0, 3);
	const extraColors = colors.slice(3);
	let colorPickerOpen = $state(false);
	const visiblePages = $derived(
		pdf
			? dual
				? page < pdf.numPages
					? [page, page + 1]
					: [page]
				: [page]
			: [page]
	);
	const recentSymbolObjects = $derived(
		recentSymbols
			.map((id) => MUSIC_SYMBOLS.find((s) => s.id === id))
			.filter((s): s is (typeof MUSIC_SYMBOLS)[number] => !!s)
	);
	const filteredSymbols = $derived.by(() => {
		const q = symbolSearch.trim().toLowerCase();
		if (q) {
			return MUSIC_SYMBOLS.filter((s) => s.name.toLowerCase().includes(q));
		}
		if (symbolCategory === 'Recent') {
			return recentSymbolObjects.length
				? recentSymbolObjects
				: MUSIC_SYMBOLS.slice(0, 24);
		}
		return MUSIC_SYMBOLS.filter((s) => s.category === symbolCategory);
	});
	const canUndo = $derived(
		layers.some((l) => l.id === activeLayer && l.visible) &&
			visiblePages.some((p) => (historyIndex[historyKey(p)] ?? 0) > 0)
	);
	const canRedo = $derived(
		layers.some((l) => l.id === activeLayer && l.visible) &&
			visiblePages.some(
				(p) =>
					(historyIndex[historyKey(p)] ?? 0) <
					(histories[historyKey(p)]?.length ?? 1) - 1
			)
	);

	async function requestWakeLock() {
		if (!keepAwake || closed) {
			wakeLockActive = false;
			return;
		}
		const ok = await acquireScreenWakeLock();
		wakeLockActive = ok;
	}

	async function releaseWakeLock() {
		await releaseScreenWakeLock();
		wakeLockActive = false;
	}

	let settingsHydrated = false;
	$effect(() => {
		const s = $settings;
		untrack(() => {
			const prevDual = dual;
			const prevAuto = autoLayout;
			autoLayout = s.autoLayout;
			keepAwake = s.keepAwake;
			annotationsVisible = s.annotationsVisible;
			textSize = s.textSize;
			if (!autoLayout) dual = s.dualPages;
			else if (typeof window !== 'undefined') {
				dual =
					window.matchMedia('(orientation: landscape)').matches &&
					window.innerWidth >= 720;
			}
			if (keepAwake) void requestWakeLock();
			else void releaseWakeLock();
			if (
				settingsHydrated &&
				(prevDual !== dual || prevAuto !== autoLayout) &&
				hasPainted
			) {
				void render({ quiet: true });
			}
			settingsHydrated = true;
		});
	});

	onMount(() => {
		try {
			const global = get(settings);
			autoLayout = global.autoLayout;
			keepAwake = global.keepAwake;
			annotationsVisible = global.annotationsVisible;
			textSize = global.textSize;
			fit = global.defaultFit;
			if (autoLayout) {
				dual =
					window.matchMedia('(orientation: landscape)').matches &&
					window.innerWidth >= 720;
			} else {
				dual = global.dualPages;
			}
			const saved = JSON.parse(localStorage.getItem(prefs) || '{}');
			bookmarked = !!saved.bookmarked;
			// Always open at 100% zoom (ignore previously saved zoom).
			zoom = 1;
			renderedZoom = 1;
			visualScale = 1;
			needsCenter = true;
			if (typeof saved.fit === 'string')
				fit = saved.fit === 'width' ? 'width' : 'page';
			recentSymbols = Array.isArray(saved.recentSymbols)
				? saved.recentSymbols
				: [];
			if (typeof saved.page === 'number' && saved.page > 0) {
				page = saved.page;
				pageInput = String(saved.page);
			}
		} catch {}
		requestPersistentStorage();
		void load();
		void requestWakeLock();
		const onVisibility = () => {
			if (document.visibilityState === 'visible') void requestWakeLock();
			else void releaseWakeLock();
		};
		document.addEventListener('visibilitychange', onVisibility);
		const key = (event: KeyboardEvent) => {
			if (handwritingSetupOpen) return;
			if (textEditor) {
				if (event.key === 'Escape') {
					event.preventDefault();
					cancelText();
				}
				return;
			}
			if (event.key === 'Escape' && (practicePanel || layersOpen)) {
				event.preventDefault();
				practicePanel = null;
				layersOpen = false;
				return;
			}
			if (
				event.target instanceof HTMLInputElement ||
				event.target instanceof HTMLTextAreaElement ||
				event.target instanceof HTMLSelectElement ||
				(event.target instanceof HTMLElement && event.target.isContentEditable)
			)
				return;
			if (
				event.key === 'ArrowRight' ||
				event.key === 'PageDown' ||
				event.key === ' '
			) {
				event.preventDefault();
				next();
			} else if (event.key === 'ArrowLeft' || event.key === 'PageUp') {
				event.preventDefault();
				previous();
			} else if (event.key === '+' || event.key === '=') setZoom(zoom + 0.08);
			else if (event.key === '-') setZoom(zoom - 0.08);
			else if (event.key.toLowerCase() === 'f') {
				event.preventDefault();
				reading ? exitReading() : enterReading();
			} else if (event.key.toLowerCase() === 'p') {
				controls = true;
				choose('pen');
			} else if (event.key.toLowerCase() === 'h') {
				controls = true;
				choose('highlighter');
			} else if (event.key.toLowerCase() === 'e') {
				controls = true;
				choose('eraser');
			} else if (event.key.toLowerCase() === 's') {
				controls = true;
				choose('symbol');
			} else if (event.key.toLowerCase() === 't') {
				controls = true;
				choose('text');
			} else if (
				(event.ctrlKey || event.metaKey) &&
				event.key.toLowerCase() === 'z'
			) {
				event.preventDefault();
				undo();
			} else if (
				(event.ctrlKey || event.metaKey) &&
				event.key.toLowerCase() === 'y'
			) {
				event.preventDefault();
				redo();
			} else if (event.key === 'Escape') {
				if (
					settingsOpen ||
					searchOpen ||
					controls ||
					reading ||
					layersOpen ||
					practicePanel
				) {
					settingsOpen = false;
					layersOpen = false;
					practicePanel = null;
					searchOpen = false;
					controls = false;
					if (reading) exitReading();
					choose('pan');
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
			resizeTimer = setTimeout(() => {
				needsCenter = true;
				void render({ quiet: true });
			}, 100);
		});
		if (host) observer.observe(host);
		if (workspace) observer.observe(workspace);
		// Pinch-to-zoom for tablets (two-finger). passive:false so we can preventDefault.
		const pinchOpts: AddEventListenerOptions = { passive: false };
		if (host) {
			host.addEventListener('touchstart', onPinchTouchStart, pinchOpts);
			host.addEventListener('touchmove', onPinchTouchMove, pinchOpts);
			host.addEventListener('touchend', onPinchTouchEnd);
			host.addEventListener('touchcancel', onPinchTouchEnd);
		}
		const onPageHide = () => {
			void flushPendingAnnotations();
		};
		window.addEventListener('pagehide', onPageHide);
		return () => {
			window.removeEventListener('keydown', key);
			document.removeEventListener('fullscreenchange', onFullscreen);
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('pagehide', onPageHide);
			if (host) {
				host.removeEventListener('touchstart', onPinchTouchStart);
				host.removeEventListener('touchmove', onPinchTouchMove);
				host.removeEventListener('touchend', onPinchTouchEnd);
				host.removeEventListener('touchcancel', onPinchTouchEnd);
			}
			observer.disconnect();
			clearTimeout(resizeTimer);
			clearTimeout(prefetchTimer);
			clearTimeout(zoomTimer);
			if (zoomRaf) cancelAnimationFrame(zoomRaf);
			stopPanMomentum();
			cancelRender();
			void releaseWakeLock();
			// Flush annotations before marking closed / tearing down canvases.
			void flushPendingAnnotations().finally(() => {
				closed = true;
				releaseCanvases();
				if (document.fullscreenElement)
					void document.exitFullscreen().catch(() => {});
				void destroyDocument();
			});
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
				throw new Error(
					'PDF data is missing. Try refreshing the library and open again.'
				);
			}
			const opening = openPdfSource({
				url: score.pdfUrl,
				blob: score.pdfBlob,
				nativePath: score.nativePath
			});
			const [opened, storedScore, records] = await Promise.all([
				opening,
				db.scores.get(score.id),
				loadAnnotations(score.id)
			]).catch((error) => {
				void opening.then(closePdf).catch(() => {});
				throw error;
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
			layers = storedScore?.annotationLayers?.length
				? storedScore.annotationLayers
				: [{ id: 'default', name: 'Annotations', visible: true }];
			activeLayer = layers.find((l) => l.visible)?.id || layers[0].id;
			layers = recoverLayers(
				storedScore?.annotationLayers,
				records.flatMap((r) => [...r.strokes, ...r.stamps, ...r.notes])
			);
			for (const record of records) {
				strokes[record.pageNum] = record.strokes || [];
				stamps[record.pageNum] = record.stamps || [];
				notes[record.pageNum] = record.notes || [];
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
		clearPageCache();
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
		await releaseWakeLock();
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

	function cancelRender(keepPages: number[] = []) {
		const kept: typeof tasks = [];
		for (const entry of tasks) {
			if (keepPages.includes(entry.number)) {
				kept.push(entry);
				continue;
			}
			entry.task.cancel();
			for (const [key, pending] of pendingPages)
				if (pending.task === entry.task) pendingPages.delete(key);
		}
		tasks = kept;
	}

	async function render(opts?: { quiet?: boolean }) {
		if (!pdf || !host || closed) return;
		cancelRender(visiblePages);
		const current = ++generation;
		if (!opts?.quiet || !hasPainted) {
			loading = true;
			loadingText = dual ? 'Rendering pages…' : 'Rendering page…';
		}
		error = '';
		try {
			if (autoLayout) {
				const landscape = window.matchMedia('(orientation: landscape)').matches;
				const wideEnough = (workspace?.clientWidth ?? host.clientWidth) >= 720;
				const nextDual = landscape && wideEnough;
				if (nextDual !== dual) {
					dual = nextDual;
					persistPrefs();
				}
			} else if ((workspace?.clientWidth ?? host.clientWidth) < 720) {
				dual = false;
			}
			// Parallelize left/right page rasterization — dual mode was sequential before.
			const results = await Promise.all(
				visiblePages.map((num, index) => renderPage(num, index, current))
			);
			if (current !== generation) return;
			const bitmaps = results.filter((b): b is PageBitmap => !!b);
			if (bitmaps.length) {
				hasPainted = true;
				commitPageBitmaps(bitmaps);
			}
		} catch (reason) {
			if (
				!(
					reason instanceof Error &&
					reason.name === 'RenderingCancelledException'
				) &&
				current === generation
			) {
				console.error('PDF render failed', reason);
				error =
					'This page could not be rendered at the current size. Try Fit Page or reduce zoom.';
			}
		} finally {
			if (current === generation) loading = false;
		}
	}

	async function renderPage(
		number: number,
		index: number,
		current: number,
		priority: 'interactive' | 'prefetch' = 'interactive'
	): Promise<PageBitmap | null> {
		if (!pdf || !host) return null;
		const pdfPage = await pdf.getPage(number);
		if (current !== generation) return null;
		const base = pdfPage.getViewport({ scale: 1 });
		const availableWidth = Math.max(
			280,
			dual
				? ((workspace?.clientWidth ?? host.clientWidth) - 92) / 2
				: (workspace?.clientWidth ?? host.clientWidth) - 58
		);
		const availableHeight = Math.max(
			280,
			(workspace?.clientHeight ?? host.clientHeight) - 72
		);
		// Layout size is always the un-zoomed fit size; zoom is applied via CSS transform.
		const fitScale =
			fit === 'width'
				? availableWidth / base.width
				: Math.min(availableWidth / base.width, availableHeight / base.height);
		const dpr = Math.min(window.devicePixelRatio || 1, 1.75);
		const area = Math.max(1, base.width * base.height);
		const safeScale = Math.sqrt(MAX_CANVAS_PIXELS / (area * dpr * dpr));
		// Bitmap resolution tracks the logical zoom so it stays sharp after settle.
		const renderScale = scoreRasterScale(fitScale, zoom, safeScale);
		const layoutScale = Math.max(0.18, Math.min(2.4, fitScale));
		return paintPage(
			pdfPage,
			number,
			index,
			layoutScale,
			renderScale,
			dpr,
			priority
		);
	}

	async function paintPage(
		pdfPage: PdfPageProxy,
		number: number,
		index: number,
		layoutScale: number,
		renderScale: number,
		dpr: number,
		priority: 'interactive' | 'prefetch'
	): Promise<PageBitmap | null> {
		const key = scoreRasterKey(number, renderScale, dpr);
		const cached = pageCache.get(key);
		if (cached) {
			// Reuse cached raster; only update the layout index for dual/single placement.
			touchCache(key, cached);
			const viewport = pdfPage.getViewport({ scale: layoutScale });
			return {
				...cached,
				index,
				number,
				widthPx: Math.ceil(viewport.width),
				heightPx: Math.ceil(viewport.height)
			};
		}

		const pending = pendingPages.get(key);
		if (pending) {
			const bmp = await pending.promise;
			const viewport = pdfPage.getViewport({ scale: layoutScale });
			return bmp
				? {
						...bmp,
						index,
						number,
						widthPx: Math.ceil(viewport.width),
						heightPx: Math.ceil(viewport.height)
					}
				: null;
		}

		// A newer zoom/size for this page supersedes queued work at older resolutions.
		for (const [otherKey, other] of pendingPages) {
			if (otherKey.startsWith(`${number}@`) && otherKey !== key) {
				other.task.cancel();
				pendingPages.delete(otherKey);
			}
		}

		// CSS size stays at fit (layoutScale) so zoom is purely a CSS transform — no layout jump on settle.
		const layoutViewport = pdfPage.getViewport({ scale: layoutScale });
		const widthPx = Math.ceil(layoutViewport.width);
		const heightPx = Math.ceil(layoutViewport.height);
		const renderViewport = pdfPage.getViewport({ scale: renderScale });
		const canvasW = Math.ceil(renderViewport.width * dpr);
		const canvasH = Math.ceil(renderViewport.height * dpr);
		if (canvasW * canvasH > MAX_CANVAS_PIXELS)
			throw new Error('Canvas exceeds safe pixel budget');

		// Keep the transferred bitmap itself in the LRU: draw once to the live canvas.
		let offscreen: HTMLCanvasElement | ImageBitmap | undefined;
		let task: PdfRenderTask;
		if (pdf?.renderBitmap) {
			const controller = new AbortController();
			task = {
				promise: pdf
					.renderBitmap(number - 1, {
						scale: renderScale * dpr,
						priority,
						signal: controller.signal
					})
					.then((image) => {
						offscreen = image;
					}),
				cancel() {
					controller.abort();
				}
			};
		} else {
			const canvas = document.createElement('canvas');
			canvas.width = canvasW;
			canvas.height = canvasH;
			offscreen = canvas;
			const context = canvas.getContext('2d', { alpha: false });
			if (!context) throw Error('2D context unavailable');
			context.setTransform(dpr, 0, 0, dpr, 0, 0);
			task = pdfPage.render({
				canvas,
				canvasContext: context,
				viewport: renderViewport,
				priority
			});
		}
		tasks.push({ task, number });
		const promise = (async () => {
			try {
				await task.promise;
				if (!offscreen) throw Error('PDF raster returned no bitmap');
				if (closed) {
					if (offscreen) releaseBitmap(offscreen);
					return null;
				}
				const bmp: PageBitmap = {
					index,
					number,
					widthPx,
					heightPx,
					canvasW: offscreen.width,
					canvasH: offscreen.height,
					offscreen
				};
				touchCache(key, bmp);
				return bmp;
			} catch (error) {
				if (offscreen) releaseBitmap(offscreen);
				throw error;
			} finally {
				tasks = tasks.filter((entry) => entry.task !== task);
				if (pendingPages.get(key)?.task === task) pendingPages.delete(key);
			}
		})();
		pendingPages.set(key, { task, promise });
		return promise;
	}

	function commitPageBitmaps(bitmaps: PageBitmap[]) {
		// Single synchronous turn: swap every page. Layout CSS size is zoom-independent,
		// so this never shifts the view — only sharpness updates.
		for (const bmp of bitmaps) {
			const pdfCanvas = bmp.index === 0 ? leftPdf : rightPdf;
			const inkCanvas = bmp.index === 0 ? leftInk : rightInk;
			if (!pdfCanvas || !inkCanvas) continue;

			if (pdfCanvas.width !== bmp.canvasW) pdfCanvas.width = bmp.canvasW;
			if (pdfCanvas.height !== bmp.canvasH) pdfCanvas.height = bmp.canvasH;
			pdfCanvas.style.width = `${bmp.widthPx}px`;
			pdfCanvas.style.height = `${bmp.heightPx}px`;
			const displayCtx = pdfCanvas.getContext('2d', { alpha: false });
			if (!displayCtx) continue;
			displayCtx.setTransform(1, 0, 0, 1, 0, 0);
			displayCtx.drawImage(bmp.offscreen, 0, 0);

			if (inkCanvas.width !== bmp.canvasW) inkCanvas.width = bmp.canvasW;
			if (inkCanvas.height !== bmp.canvasH) inkCanvas.height = bmp.canvasH;
			inkCanvas.style.width = `${bmp.widthPx}px`;
			inkCanvas.style.height = `${bmp.heightPx}px`;
			redraw(bmp.number, inkCanvas);
		}
		renderedZoom = zoom;
		visualScale = 1;
		if (needsCenter) {
			centerPages();
			needsCenter = false;
		}
		schedulePrefetch();
	}

	/** Center the score in the workspace (used on open / fit / page jumps). */
	function centerPages() {
		if (!host) return;
		const leftW = leftPdf
			? Number.parseFloat(leftPdf.style.width) || leftPdf.clientWidth
			: 0;
		const leftH = leftPdf
			? Number.parseFloat(leftPdf.style.height) || leftPdf.clientHeight
			: 0;
		// When dual is on but we're on the final odd page, only one page is shown.
		const showRight = dual && visiblePages.length > 1 && rightPdf;
		const rightW = showRight
			? Number.parseFloat(rightPdf!.style.width) || rightPdf!.clientWidth
			: 0;
		const gap = showRight && rightW ? 20 : 0;
		const contentW = leftW + gap + rightW;
		const contentH = leftH;
		panX = ((workspace?.clientWidth ?? host.clientWidth) - contentW * zoom) / 2;
		panY = Math.max(
			12,
			((workspace?.clientHeight ?? host.clientHeight) - contentH * zoom) / 2
		);
	}

	function schedulePrefetch() {
		clearTimeout(prefetchTimer);
		prefetchTimer = setTimeout(() => {
			if (!pdf || !host || closed) return;
			const step = dual ? 2 : 1;
			const upcoming = [step, -step, step * 2, -step * 2, step * 3].flatMap(
				(offset) =>
					dual ? [page + offset, page + offset + 1] : [page + offset]
			);
			const largestPage = Math.max(
				1,
				...[...pageCache.values()]
					.filter((bmp) => visiblePages.includes(bmp.number))
					.map((bmp) => bmp.canvasW * bmp.canvasH)
			);
			const capacity = Math.max(
				0,
				Math.min(
					8,
					Math.floor(MAX_CACHE_PIXELS / largestPage) - visiblePages.length
				)
			);
			const unique = [...new Set(upcoming)]
				.filter(
					(n) =>
						n >= 1 && n <= (pdf?.numPages ?? 0) && !visiblePages.includes(n)
				)
				.slice(0, capacity);
			// Warm page objects + fully rasterize into cache at current scale so
			// page turns and long jumps feel instantaneous.
			void (async () => {
				const current = generation;
				for (const number of unique) {
					if (closed || current !== generation) return;
					try {
						// renderPage already checks/uses cache and writes back into it
						await renderPage(number, 0, current, 'prefetch');
					} catch {
						/* ignore prefetch failures */
					}
				}
			})();
		}, 40);
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
		// Layout box (not getBoundingClientRect) so ink scales with CSS zoom.
		const w = Math.max(1, canvas.clientWidth);
		const h = Math.max(1, canvas.clientHeight);
		return { x: point.x * w, y: point.y * h };
	}
	let handwritingStatus = $state('Write a symbol or text; pause to convert.');
	let handwritingMode = $state<RecognitionMode>('auto');
	let handwritingPauseMs = $state(loadHandwritingPause());
	let handwritingRetryAvailable = $state(false);
	let handwritingSetupOpen = $state(false);
	let handwritingTimer: ReturnType<typeof setTimeout> | undefined;
	let handwritingEpoch = 0;
	let handwritingBatch: { page: number; layer: string; ids: string[] } | null =
		null;
	let recognitionQueue: Promise<unknown> = Promise.resolve();
	function cancelHandwriting() {
		clearTimeout(handwritingTimer);
		handwritingEpoch++;
		handwritingBatch = null;
		handwritingRetryAvailable = false;
	}
	function queueHandwriting(
		number: number,
		canvas: HTMLCanvasElement,
		stroke: Stroke
	) {
		if (!stroke.id) return;
		if (
			!handwritingBatch ||
			handwritingBatch.page !== number ||
			handwritingBatch.layer !== activeLayer
		)
			handwritingBatch = { page: number, layer: activeLayer, ids: [] };
		if (!handwritingBatch.ids.includes(stroke.id))
			handwritingBatch.ids.push(stroke.id);
		handwritingRetryAvailable = false;
		const batch = { ...handwritingBatch, ids: [...handwritingBatch.ids] };
		const epoch = ++handwritingEpoch;
		clearTimeout(handwritingTimer);
		handwritingStatus = 'Waiting for you to finish writing…';
		handwritingTimer = setTimeout(() => {
			const scoreId = score.id;
			const baseline = JSON.stringify(snapshot(number));
			const valid = () =>
				epoch === handwritingEpoch &&
				!closed &&
				tool === 'handwriting' &&
				score.id === scoreId &&
				activeLayer === batch.layer &&
				visiblePages.includes(number) &&
				layers.some((l) => l.id === batch.layer && l.visible) &&
				!drawing &&
				!draggingAnnot &&
				baseline === JSON.stringify(snapshot(number));
			recognitionQueue = recognitionQueue
				.catch(() => undefined)
				.then(async () => {
					if (!valid()) return;
					handwritingStatus = 'Recognizing on this device…';
					try {
						const ink = cloneData(
							(strokes[number] || []).filter(
								(s) => !!s.id && batch.ids.includes(s.id)
							)
						);
						if (ink.length !== batch.ids.length) return;
						const sample = handwritingImage(
							ink,
							canvas.clientWidth,
							canvas.clientHeight
						);
						const result = await recognizeHandwriting(
							sample.image,
							sample.ink,
							handwritingMode
						);
						if (!valid()) return;
						if (!result) {
							handwritingStatus =
								'Could not recognize that. Add more strokes or retry.';
							handwritingRetryAvailable = true;
							return;
						}
						handwritingBatch = null;
						const base = {
							id: crypto.randomUUID(),
							layerId: batch.layer,
							color: ink[0].color
						};
						if (result.kind === 'symbol') {
							stamps[number] = [
								...(stamps[number] || []),
								{
									...base,
									symbol: result.symbol.glyph,
									label: result.symbol.name,
									x: sample.x + sample.width / 2,
									y: sample.y + sample.height / 2,
									fontSize: Math.max(
										16,
										Math.min(120, sample.height * canvas.clientHeight)
									)
								}
							];
						} else {
							notes[number] = [
								...(notes[number] || []),
								{
									...base,
									text: result.text,
									x: sample.x,
									y: sample.y,
									fontSize: Math.max(
										12,
										Math.min(72, sample.height * canvas.clientHeight)
									)
								}
							];
						}
						strokes[number] = (strokes[number] || []).filter(
							(s) => !s.id || !batch.ids.includes(s.id)
						);
						checkpoint(number);
						redraw(number, canvas);
						handwritingStatus =
							'Converted. Drag to move; Undo restores your ink.';
					} catch (error) {
						if (valid()) {
							handwritingRetryAvailable = true;
							handwritingStatus = `${String(error)} Your ink is preserved.`;
						}
					}
				});
		}, handwritingPauseMs);
	}
	function retryHandwriting() {
		const batch = handwritingBatch;
		if (!batch) return;
		const canvas = batch.page === visiblePages[0] ? leftInk : rightInk;
		const stroke = (strokes[batch.page] || []).find(
			(s) => s.id === batch.ids.at(-1)
		);
		if (canvas && stroke) queueHandwriting(batch.page, canvas, stroke);
	}
	function choose(nextTool: Tool) {
		cancelHandwriting();
		tool = nextTool;
		if (nextTool === 'handwriting')
			void prepareRecognition().catch((error) => {
				if (closed || tool !== 'handwriting') return;
				handwritingStatus = String(error);
				handwritingSetupOpen = true;
			});
		if (nextTool !== 'text') {
			textEditor = null;
			textDraft = '';
		}
		if (nextTool !== 'eraser' && nextTool !== 'symbol') cursorScreen = null;
		if (nextTool === 'symbol') {
			symbolSheetCollapsed = false;
		}
	}

	function hitAnnotation(
		number: number,
		point: Point,
		radius = 0.04
	): { kind: 'stamp' | 'note'; id: string } | null {
		for (let i = (stamps[number] || []).length - 1; i >= 0; i--) {
			const stamp = stamps[number][i];
			if (!editable(stamp)) continue;
			if (Math.hypot(stamp.x - point.x, stamp.y - point.y) <= radius)
				return { kind: 'stamp', id: stamp.id };
		}
		for (let i = (notes[number] || []).length - 1; i >= 0; i--) {
			const note = notes[number][i];
			if (!editable(note)) continue;
			if (Math.hypot(note.x - point.x, note.y - point.y) <= radius)
				return { kind: 'note', id: note.id };
		}
		return null;
	}

	function placeSymbolAt(
		number: number,
		point: Point,
		canvas: HTMLCanvasElement | null
	) {
		if (!layers.some((l) => l.id === activeLayer && l.visible)) return;
		ensureHistory(number);
		const stamp = {
			id: crypto.randomUUID(),
			layerId: activeLayer,
			symbol: selectedSymbol.glyph,
			label: selectedSymbol.name,
			x: point.x,
			y: point.y,
			fontSize: symbolSize,
			color
		};
		stamps[number] = [...(stamps[number] || []), stamp];
		recentSymbols = [
			selectedSymbol.id,
			...recentSymbols.filter((id) => id !== selectedSymbol.id)
		].slice(0, 10);
		symbolSheetCollapsed = true;
		persistPrefs();
		if (canvas) redraw(number, canvas);
		checkpoint(number);
	}

	function placeSymbolOnPage() {
		const canvas = leftInk ?? rightInk;
		placeSymbolAt(page, { x: 0.5, y: 0.4 }, canvas);
	}

	function begin(
		event: PointerEvent,
		number: number,
		canvas: HTMLCanvasElement
	) {
		if (
			reading ||
			!annotating ||
			!layers.some((l) => l.id === activeLayer && l.visible)
		)
			return;
		if (
			event.pointerType === 'touch' ||
			event.button !== 0 ||
			drawing ||
			draggingAnnot
		)
			return;
		clearTimeout(handwritingTimer);
		handwritingEpoch++;
		handwritingRetryAvailable = false;
		if (textEditor) {
			commitText();
			return;
		}
		event.preventDefault();
		ensureHistory(number);
		const point = position(event, canvas);
		if (tool !== 'eraser') {
			const hit = hitAnnotation(
				number,
				point,
				tool === 'symbol' || tool === 'text' ? 0.05 : 0.035
			);
			if (hit) {
				try {
					canvas.setPointerCapture(event.pointerId);
				} catch {}
				draggingAnnot = {
					kind: hit.kind,
					page: number,
					id: hit.id,
					canvas,
					pointerId: event.pointerId
				};
				return;
			}
		}
		try {
			canvas.setPointerCapture(event.pointerId);
		} catch {}
		if (tool === 'symbol') {
			placeSymbolAt(number, point, canvas);
			return;
		}
		if (tool === 'text') {
			openTextEditor(number, point);
			return;
		}
		if (tool === 'eraser') {
			drawing = { page: number, canvas, pointerId: event.pointerId };
			isDrawing = true;
			erase(point, number, canvas, false);
			return;
		}
		const stroke: Stroke = {
			id: crypto.randomUUID(),
			layerId: activeLayer,
			tool: tool === 'highlighter' ? 'highlighter' : 'pen',
			kind: tool === 'line' ? 'line' : tool === 'arrow' ? 'arrow' : 'freehand',
			color,
			width,
			points: [point]
		};
		ensureHistory(number);
		strokes[number] = [...(strokes[number] || []), stroke];
		drawing = { page: number, canvas, pointerId: event.pointerId, stroke };
		isDrawing = true;
		redraw(number, canvas);
	}

	function openTextEditor(number: number, point: Point) {
		ensureHistory(number);
		const existing = (notes[number] || []).find(
			(note) =>
				editable(note) && Math.hypot(note.x - point.x, note.y - point.y) < 0.04
		);
		const x = Math.min(0.92, Math.max(0.04, point.x));
		const y = Math.min(0.92, Math.max(0.04, point.y));
		const canvas = number === visiblePages[0] ? leftInk : rightInk;
		let screenX = 24;
		let screenY = 120;
		if (canvas) {
			const rect = canvas.getBoundingClientRect();
			screenX = rect.left + x * rect.width;
			screenY = rect.top + y * rect.height;
			// Prefer editor above the tap; flip below if near top
			if (screenY < 100) screenY += 28;
			else screenY -= 12;
			// Keep fully on screen
			screenX = Math.min(window.innerWidth - 300, Math.max(12, screenX - 20));
			screenY = Math.min(window.innerHeight - 80, Math.max(12, screenY));
		}
		textDraft = existing?.text || '';
		textEditor = {
			page: number,
			x,
			y,
			text: textDraft,
			id: existing?.id,
			screenX,
			screenY
		};
		void tick().then(() => {
			const el = document.querySelector<HTMLInputElement>(
				'[data-score-text-input]'
			);
			el?.focus();
			el?.select();
		});
	}
	function commitText() {
		if (!textEditor) return;
		const editor = textEditor;
		const text = textDraft.trim();
		textEditor = null;
		textDraft = '';
		if (text) {
			if (editor.id)
				notes[editor.page] = (notes[editor.page] || []).map((note) =>
					note.id === editor.id
						? { ...note, text, fontSize: textSize, color }
						: note
				);
			else
				notes[editor.page] = [
					...(notes[editor.page] || []),
					{
						id: crypto.randomUUID(),
						layerId: activeLayer,
						text,
						x: editor.x,
						y: editor.y,
						fontSize: textSize,
						color
					}
				];
			const canvas = editor.page === visiblePages[0] ? leftInk : rightInk;
			if (canvas) redraw(editor.page, canvas);
			checkpoint(editor.page);
		}
	}
	function cancelText() {
		textEditor = null;
		textDraft = '';
	}

	function updateCursorOverlay(
		event: PointerEvent,
		canvas?: HTMLCanvasElement | null
	) {
		if (tool !== 'eraser' && tool !== 'symbol') {
			cursorScreen = null;
			return;
		}
		// Ghost / eraser ring tracks the pointer; placement is still click-to-stamp.
		cursorScreen = { x: event.clientX, y: event.clientY };
	}

	function move(event: PointerEvent) {
		if (event.pointerType === 'touch') return;
		const activePointer = draggingAnnot?.pointerId ?? drawing?.pointerId;
		if (activePointer !== undefined && activePointer !== event.pointerId)
			return;
		const targetCanvas =
			draggingAnnot?.canvas ||
			drawing?.canvas ||
			(event.currentTarget instanceof HTMLCanvasElement
				? event.currentTarget
				: null);
		updateCursorOverlay(event, targetCanvas);

		if (draggingAnnot) {
			const point = position(event, draggingAnnot.canvas);
			const x = Math.min(0.98, Math.max(0.02, point.x));
			const y = Math.min(0.98, Math.max(0.02, point.y));
			if (draggingAnnot.kind === 'stamp') {
				stamps[draggingAnnot.page] = (stamps[draggingAnnot.page] || []).map(
					(stamp) =>
						stamp.id === draggingAnnot!.id ? { ...stamp, x, y } : stamp
				);
			} else {
				notes[draggingAnnot.page] = (notes[draggingAnnot.page] || []).map(
					(note) => (note.id === draggingAnnot!.id ? { ...note, x, y } : note)
				);
			}
			redraw(draggingAnnot.page, draggingAnnot.canvas);
			return;
		}
		if (!drawing) return;
		const coalesced = event.getCoalescedEvents?.();
		for (const pointEvent of coalesced?.length ? coalesced : [event]) {
			if (drawing.stroke) {
				const stroke = (strokes[drawing.page] || []).find(
					(item) => item.id === drawing?.stroke?.id
				);
				if (stroke) {
					const point = position(pointEvent, drawing.canvas);
					stroke.points =
						stroke.kind === 'line' || stroke.kind === 'arrow'
							? [stroke.points[0], point]
							: [...stroke.points, point];
				}
			} else
				erase(
					position(pointEvent, drawing.canvas),
					drawing.page,
					drawing.canvas,
					false
				);
		}
		if (!drawing.raf)
			drawing.raf = requestAnimationFrame(() => {
				if (drawing) redraw(drawing.page, drawing.canvas);
				if (drawing) drawing.raf = undefined;
			});
	}
	function end(event: PointerEvent) {
		const activePointer = draggingAnnot?.pointerId ?? drawing?.pointerId;
		if (activePointer !== undefined && activePointer !== event.pointerId)
			return;
		if (event.type === 'pointercancel') cancelHandwriting();
		if (draggingAnnot) {
			const active = draggingAnnot;
			draggingAnnot = null;
			try {
				active.canvas.releasePointerCapture(active.pointerId);
			} catch {}
			checkpoint(active.page);
			redraw(active.page, active.canvas);
			return;
		}
		if (!drawing) return;
		const active = drawing;
		if (active.stroke && event.type !== 'pointercancel') {
			const stroke = (strokes[active.page] || []).find(
				(s) => s.id === active.stroke?.id
			);
			if (stroke)
				stroke.points = [...stroke.points, position(event, active.canvas)];
		}
		if (active.raf) cancelAnimationFrame(active.raf);
		drawing = null;
		isDrawing = false;
		try {
			active.canvas.releasePointerCapture(active.pointerId);
		} catch {}
		redraw(active.page, active.canvas);
		checkpoint(active.page);
		if (
			tool === 'handwriting' &&
			active.stroke &&
			event.type !== 'pointercancel'
		)
			queueHandwriting(active.page, active.canvas, active.stroke);
	}

	function onInkPointerLeave() {
		if (!drawing && !draggingAnnot) cursorScreen = null;
	}
	function distPointToSegment(p: Point, a: Point, b: Point): number {
		const dx = b.x - a.x;
		const dy = b.y - a.y;
		const len2 = dx * dx + dy * dy;
		if (len2 < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y);
		let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
		t = Math.max(0, Math.min(1, t));
		return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
	}

	function strokeHitsEraser(
		stroke: Stroke,
		point: Point,
		radius: number
	): boolean {
		const pts = stroke.points;
		if (!pts.length) return false;
		// Point hits (works for freehand samples and endpoints)
		for (const candidate of pts) {
			if (Math.hypot(candidate.x - point.x, candidate.y - point.y) < radius)
				return true;
		}
		// Segment hits — critical for line / arrow (often only 2 points)
		for (let i = 1; i < pts.length; i++) {
			if (distPointToSegment(point, pts[i - 1], pts[i]) < radius) return true;
		}
		return false;
	}

	function erase(
		point: Point,
		number: number,
		canvas: HTMLCanvasElement | null,
		save = true
	) {
		const radius = Math.max(0.012, width / 700);
		let changed = false;
		const before = strokes[number] || [];
		const after = before.filter(
			(stroke) => !editable(stroke) || !strokeHitsEraser(stroke, point, radius)
		);
		if (after.length !== before.length) {
			strokes[number] = after;
			changed = true;
		}
		const nextStamps = (stamps[number] || []).filter(
			(stamp) =>
				!editable(stamp) ||
				Math.hypot(stamp.x - point.x, stamp.y - point.y) > radius * 1.6
		);
		if (nextStamps.length !== (stamps[number] || []).length) {
			stamps[number] = nextStamps;
			changed = true;
		}
		const nextNotes = (notes[number] || []).filter(
			(note) =>
				!editable(note) ||
				Math.hypot(note.x - point.x, note.y - point.y) > radius * 1.8
		);
		if (nextNotes.length !== (notes[number] || []).length) {
			notes[number] = nextNotes;
			changed = true;
		}
		if (changed) {
			if (canvas) redraw(number, canvas);
			if (save) checkpoint(number);
		}
	}

	function redraw(number: number, canvas: HTMLCanvasElement | null) {
		if (!canvas) return;
		const context = canvas.getContext('2d')!;
		// Pre-zoom layout pixels; parent scale(zoom) scales symbols/text with the page.
		const layoutW = Math.max(1, canvas.clientWidth);
		const layoutH = Math.max(1, canvas.clientHeight);
		const scale = canvas.width / layoutW;
		context.setTransform(scale, 0, 0, scale, 0, 0);
		context.clearRect(0, 0, layoutW, layoutH);
		if (!annotationsVisible) return;
		for (const layer of [...layers].reverse()) {
			if (!layer.visible) continue;
			for (const stroke of (strokes[number] || []).filter(
				(m) => (m.layerId || 'default') === layer.id
			))
				drawStroke(context, stroke, canvas);
			context.save();
			context.textAlign = 'center';
			context.textBaseline = 'middle';
			for (const stamp of (stamps[number] || []).filter(
				(m) => (m.layerId || 'default') === layer.id
			)) {
				const p = pointToCanvas({ x: stamp.x, y: stamp.y }, canvas);
				context.font = `${stamp.fontSize}px Leland, serif`;
				context.fillStyle = stamp.color;
				context.fillText(stamp.symbol, p.x, p.y);
			}
			context.restore();
			for (const note of (notes[number] || []).filter(
				(m) => (m.layerId || 'default') === layer.id
			)) {
				const p = pointToCanvas({ x: note.x, y: note.y }, canvas);
				context.save();
				context.font = `600 ${note.fontSize}px system-ui,sans-serif`;
				context.fillStyle = note.color;
				context.textBaseline = 'top';
				context.shadowColor = 'rgba(255,255,255,.85)';
				context.shadowBlur = 3;
				context.fillText(note.text, p.x, p.y);
				context.restore();
			}
		}
	}

	function drawStroke(
		context: CanvasRenderingContext2D,
		stroke: Stroke,
		canvas: HTMLCanvasElement
	) {
		if (!stroke.points.length) return;
		const points = stroke.points.map((p) => pointToCanvas(p, canvas));
		context.save();
		context.strokeStyle = stroke.color;
		context.fillStyle = stroke.color;
		context.lineWidth = stroke.width;
		context.lineCap = 'round';
		context.lineJoin = 'round';
		if (stroke.tool === 'highlighter') context.globalAlpha = 0.28;
		if (stroke.kind === 'line' || stroke.kind === 'arrow') {
			const a = points[0];
			const b = points[points.length - 1];
			context.beginPath();
			context.moveTo(a.x, a.y);
			context.lineTo(b.x, b.y);
			context.stroke();
			if (stroke.kind === 'arrow') {
				const angle = Math.atan2(b.y - a.y, b.x - a.x);
				const size = Math.max(8, stroke.width * 3);
				context.beginPath();
				context.moveTo(b.x, b.y);
				context.lineTo(
					b.x - size * Math.cos(angle - Math.PI / 6),
					b.y - size * Math.sin(angle - Math.PI / 6)
				);
				context.lineTo(
					b.x - size * Math.cos(angle + Math.PI / 6),
					b.y - size * Math.sin(angle + Math.PI / 6)
				);
				context.closePath();
				context.fill();
			}
		} else {
			context.beginPath();
			context.moveTo(points[0].x, points[0].y);
			for (let i = 1; i < points.length; i++)
				context.lineTo(points[i].x, points[i].y);
			context.stroke();
		}
		context.restore();
	}

	/** Deep plain copy — Svelte 5 $state proxies cannot be structuredClone'd. */
	function cloneData<T>(value: T): T {
		return $state.snapshot(value) as T;
	}
	function snapshot(number: number): Snapshot {
		return {
			strokes: cloneData(strokes[number] || []),
			stamps: cloneData(stamps[number] || []),
			notes: cloneData(notes[number] || [])
		};
	}
	function ensureHistory(number: number) {
		if (!histories[historyKey(number)]) {
			histories = { ...histories, [historyKey(number)]: [snapshot(number)] };
			historyIndex = { ...historyIndex, [historyKey(number)]: 0 };
		}
	}
	function checkpoint(number: number) {
		ensureHistory(number);
		const list = histories[historyKey(number)];
		const index = historyIndex[historyKey(number)] ?? list.length - 1;
		const nextList = [...list.slice(0, index + 1), snapshot(number)].slice(-80);
		histories = { ...histories, [historyKey(number)]: nextList };
		historyIndex = {
			...historyIndex,
			[historyKey(number)]: nextList.length - 1
		};
		scheduleSave(number);
	}
	function applySnapshot(number: number, state: Snapshot) {
		strokes = {
			...strokes,
			[number]: replaceLayerMarks(
				strokes[number] || [],
				cloneData(state.strokes),
				activeLayer
			)
		};
		stamps = {
			...stamps,
			[number]: replaceLayerMarks(
				stamps[number] || [],
				cloneData(state.stamps),
				activeLayer
			)
		};
		notes = {
			...notes,
			[number]: replaceLayerMarks(
				notes[number] || [],
				cloneData(state.notes),
				activeLayer
			)
		};
		const canvas =
			number === visiblePages[0]
				? leftInk
				: number === visiblePages[1]
					? rightInk
					: null;
		if (canvas) redraw(number, canvas);
		scheduleSave(number);
	}
	function undo() {
		cancelHandwriting();
		if (!layers.some((l) => l.id === activeLayer && l.visible)) return;
		for (const p of visiblePages) {
			ensureHistory(p);
			const index = historyIndex[historyKey(p)] ?? 0;
			if (index > 0) {
				historyIndex = { ...historyIndex, [historyKey(p)]: index - 1 };
				applySnapshot(p, histories[historyKey(p)][index - 1]);
			}
		}
	}
	function redo() {
		cancelHandwriting();
		if (!layers.some((l) => l.id === activeLayer && l.visible)) return;
		for (const p of visiblePages) {
			ensureHistory(p);
			const index = historyIndex[historyKey(p)] ?? 0;
			const list = histories[historyKey(p)];
			if (index < list.length - 1) {
				historyIndex = { ...historyIndex, [historyKey(p)]: index + 1 };
				applySnapshot(p, list[index + 1]);
			}
		}
	}
	function scheduleSave(number: number) {
		const old = saveTimers.get(number);
		if (old) clearTimeout(old);
		saveTimers.set(
			number,
			setTimeout(() => {
				saveTimers.delete(number);
				void saveAnnotations(number).catch((error) =>
					console.error('Annotation save failed', error)
				);
			}, 150)
		);
	}
	async function saveAnnotations(number: number) {
		await saveAnnotation(score.id, number, {
			strokes: $state.snapshot(strokes[number] || []),
			stamps: $state.snapshot(stamps[number] || []),
			notes: $state.snapshot(notes[number] || [])
		});
	}

	function persistPrefs() {
		localStorage.setItem(
			prefs,
			JSON.stringify({ bookmarked, zoom, fit, recentSymbols, page })
		);
	}
	function setZoom(
		value: number,
		opts: { immediate?: boolean; focusX?: number; focusY?: number } = {}
	) {
		const next = Math.max(0.35, Math.min(3, Number(value.toFixed(3))));
		const prev = zoom;
		if (Math.abs(next - prev) < 0.0005 && !opts.immediate) return;

		// Keep the focal point fixed in the workspace (cursor for wheel, center otherwise).
		// transform: translate(pan) scale(zoom) with origin 0 0
		//   workspace = pan + local * zoom  ⇒  local = (workspace - pan) / zoom
		const fx =
			opts.focusX ??
			(host ? (workspace?.clientWidth ?? host.clientWidth) / 2 : 0);
		const fy =
			opts.focusY ??
			(host ? (workspace?.clientHeight ?? host.clientHeight) / 2 : 0);
		if (prev > 0.0001) {
			const localX = (fx - panX) / prev;
			const localY = (fy - panY) / prev;
			panX = fx - localX * next;
			panY = fy - localY * next;
		}
		zoom = next;
		visualScale = 1; // zoom is applied directly via CSS transform
		persistPrefs();
		clearTimeout(zoomTimer);
		const delay = opts.immediate ? 0 : 180;
		zoomTimer = setTimeout(() => void commitZoomRender(), delay);
	}
	async function commitZoomRender() {
		if (closed) return;
		// Re-rasterize at the new zoom for sharpness. Layout CSS size is unchanged,
		// so the view position does not jump.
		await render({ quiet: hasPainted });
	}
	function setFit(value: Fit) {
		fit = value;
		zoom = 1;
		visualScale = 1;
		renderedZoom = 1;
		needsCenter = true;
		resetPan();
		persistPrefs();
		void render({ quiet: hasPainted });
	}
	function next() {
		cancelHandwriting();
		if (!pdf) return;
		pageTransition = true;
		stopPanMomentum();
		needsCenter = true;
		page = Math.min(
			pdf.numPages,
			dual ? Math.min(pdf.numPages, page + 2) : page + 1
		);
		pageInput = String(page);
		ensureHistory(page);
		persistPrefs();
		void render({ quiet: hasPainted }).finally(() => {
			requestAnimationFrame(() => {
				pageTransition = false;
			});
		});
	}
	function previous() {
		cancelHandwriting();
		if (!pdf) return;
		pageTransition = true;
		stopPanMomentum();
		needsCenter = true;
		page = Math.max(1, dual ? page - 2 : page - 1);
		pageInput = String(page);
		ensureHistory(page);
		persistPrefs();
		void render({ quiet: hasPainted }).finally(() => {
			requestAnimationFrame(() => {
				pageTransition = false;
			});
		});
	}
	function goToPage() {
		cancelHandwriting();
		const value = Math.max(
			1,
			Math.min(pdf?.numPages || 1, Number.parseInt(pageInput, 10) || 1)
		);
		const nextPage = dual && value % 2 === 0 ? value - 1 : value;
		if (nextPage === page) return;
		stopPanMomentum();
		needsCenter = true;
		page = nextPage;
		pageInput = String(page);
		ensureHistory(page);
		persistPrefs();
		void render({ quiet: hasPainted });
	}
	function toggleBookmark() {
		bookmarked = !bookmarked;
		persistPrefs();
	}
	function toggleAnnotations() {
		annotationsVisible = !annotationsVisible;
		persistPrefs();
		for (const number of visiblePages)
			redraw(number, number === visiblePages[0] ? leftInk : rightInk);
	}
	function toggleControls() {
		controls = !controls;
		if (!controls) {
			settingsOpen = false;
			colorPickerOpen = false;
			choose('pan');
		} else if (tool === 'pan') {
			choose('pen');
		}
	}
	function enterReading() {
		reading = true;
		controls = false;
		settingsOpen = false;
		searchOpen = false;
		choose('pan');
	}
	function exitReading() {
		reading = false;
	}

	function stopPanMomentum() {
		if (panMomentumRaf) {
			cancelAnimationFrame(panMomentumRaf);
			panMomentumRaf = 0;
		}
		panVx = 0;
		panVy = 0;
	}

	function resetPan() {
		stopPanMomentum();
		panX = 0;
		panY = 0;
		needsCenter = true;
	}

	function startPanMomentum() {
		stopPanMomentum();
		const friction = 0.94;
		const minV = 0.12;
		const tick = () => {
			panVx *= friction;
			panVy *= friction;
			if (Math.hypot(panVx, panVy) < minV) {
				panMomentumRaf = 0;
				panVx = 0;
				panVy = 0;
				return;
			}
			panX += panVx;
			panY += panVy;
			panMomentumRaf = requestAnimationFrame(tick);
		};
		panMomentumRaf = requestAnimationFrame(tick);
	}

	function touchDistance(a: Touch, b: Touch) {
		return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
	}
	function touchMidpoint(a: Touch, b: Touch) {
		return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
	}
	function cancelActiveStroke() {
		cancelHandwriting();
		if (drawing) {
			const active = drawing;
			if (active.raf) cancelAnimationFrame(active.raf);
			drawing = null;
			isDrawing = false;
			try {
				active.canvas.releasePointerCapture(active.pointerId);
			} catch {}
		}
		if (draggingAnnot) {
			const active = draggingAnnot;
			draggingAnnot = null;
			try {
				active.canvas.releasePointerCapture(active.pointerId);
			} catch {}
		}
		panDrag = null;
		stopPanMomentum();
	}
	function onPinchTouchStart(event: TouchEvent) {
		if (event.touches.length !== 2 || !host) return;
		event.preventDefault();
		cancelActiveStroke();
		const a = event.touches[0];
		const b = event.touches[1];
		const mid = touchMidpoint(a, b);
		const rect = (workspace ?? host).getBoundingClientRect();
		pinch = {
			lastDist: Math.max(1, touchDistance(a, b)),
			lastMidX: mid.x - rect.left,
			lastMidY: mid.y - rect.top
		};
	}
	function onPinchTouchMove(event: TouchEvent) {
		if (!pinch || event.touches.length < 2 || !host) return;
		event.preventDefault();
		const a = event.touches[0];
		const b = event.touches[1];
		const dist = Math.max(1, touchDistance(a, b));
		const rect = (workspace ?? host).getBoundingClientRect();
		const mid = touchMidpoint(a, b);
		const midX = mid.x - rect.left;
		const midY = mid.y - rect.top;
		const factor = dist / pinch.lastDist;
		// Keep the score under your fingers while pinching.
		panX += midX - pinch.lastMidX;
		panY += midY - pinch.lastMidY;
		pinch.lastDist = dist;
		pinch.lastMidX = midX;
		pinch.lastMidY = midY;
		if (Math.abs(factor - 1) > 0.001) {
			setZoom(zoom * factor, { focusX: midX, focusY: midY });
		}
	}
	function onPinchTouchEnd(event: TouchEvent) {
		if (event.touches.length < 2) pinch = null;
	}

	function onWorkspacePointerDown(event: PointerEvent) {
		if (event.pointerType === 'touch') return;
		if (annotating || reading || textEditor) return;
		if (event.button !== 0 && event.pointerType === 'mouse') return;
		stopPanMomentum();
		panDrag = {
			pointerId: event.pointerId,
			lastX: event.clientX,
			lastY: event.clientY,
			lastT: performance.now()
		};
		panVx = 0;
		panVy = 0;
		try {
			(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
		} catch {}
	}

	function onWorkspacePointerMove(event: PointerEvent) {
		if (!panDrag || event.pointerId !== panDrag.pointerId) return;
		const now = performance.now();
		const dt = Math.max(8, now - panDrag.lastT);
		const dx = event.clientX - panDrag.lastX;
		const dy = event.clientY - panDrag.lastY;
		panX += dx;
		panY += dy;
		// velocity in px per frame (~16ms)
		const scale = 16 / dt;
		panVx = dx * scale;
		panVy = dy * scale;
		panDrag.lastX = event.clientX;
		panDrag.lastY = event.clientY;
		panDrag.lastT = now;
	}

	function onWorkspacePointerUp(event: PointerEvent) {
		if (!panDrag || event.pointerId !== panDrag.pointerId) return;
		panDrag = null;
		try {
			(event.currentTarget as HTMLElement).releasePointerCapture(
				event.pointerId
			);
		} catch {}
		if (Math.hypot(panVx, panVy) > 0.8) startPanMomentum();
		else {
			panVx = 0;
			panVy = 0;
		}
	}

	function onWheel(event: WheelEvent) {
		event.preventDefault();
		if (event.ctrlKey || event.metaKey) {
			const pixelDelta =
				event.deltaMode === 1
					? event.deltaY * 16
					: event.deltaMode === 2
						? event.deltaY * 40
						: event.deltaY;
			const factor = Math.exp(-pixelDelta * 0.0016);
			zoomPending = Math.max(0.35, Math.min(3, zoom * factor));
			if (host) {
				const rect = (workspace ?? host).getBoundingClientRect();
				zoomFocusX = event.clientX - rect.left;
				zoomFocusY = event.clientY - rect.top;
			}
			if (!zoomRaf) {
				zoomRaf = requestAnimationFrame(() => {
					zoomRaf = 0;
					if (zoomPending != null) {
						setZoom(zoomPending, { focusX: zoomFocusX, focusY: zoomFocusY });
						zoomPending = null;
					}
				});
			}
			return;
		}
		stopPanMomentum();
		const factor = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 40 : 1;
		panX -= event.deltaX * factor;
		panY -= event.deltaY * factor;
	}
	async function searchPdf() {
		if (!pdf || !searchText.trim()) return;
		searchStatus = 'Searching…';
		const needle = searchText.trim().toLowerCase();
		for (let number = 1; number <= pdf.numPages; number++) {
			try {
				const p = await pdf.getPage(number);
				const content = await p.getTextContent();
				const text = content.items
					.map((item) => ('str' in item ? item.str : ''))
					.join(' ')
					.toLowerCase();
				if (text.includes(needle)) {
					page = number;
					pageInput = String(number);
					searchStatus = `Found on page ${number}`;
					persistPrefs();
					void render({ quiet: hasPainted });
					return;
				}
			} catch {}
		}
		searchStatus = 'Not found';
	}
	function downloadScore() {
		const href =
			score.pdfUrl || (score.pdfBlob ? URL.createObjectURL(score.pdfBlob) : '');
		if (!href) return;
		const link = document.createElement('a');
		link.href = href;
		link.download = `${score.title}.pdf`;
		link.target = '_blank';
		link.rel = 'noopener';
		link.click();
		if (score.pdfBlob && !score.pdfUrl)
			setTimeout(() => URL.revokeObjectURL(href), 1000);
	}
	function printScore() {
		window.print();
	}
	async function toggleFullScreen() {
		if (!document.fullscreenElement) await host?.requestFullscreen();
		else await document.exitFullscreen();
	}
</script>

<svelte:head><title>{score.title} — Sonora</title></svelte:head>

<div class="viewer" bind:this={host} class:reading>
	{#if !reading}
		<header class="topbar">
			<div class="topbar-left">
				<button
					class="icon-button"
					title="Back to library"
					aria-label="Back to library"
					onclick={() => void leave()}><ArrowLeft size={19} /></button>
				<div class="score-title">
					<strong>{score.title}</strong><span
						>{formatComposer(score.composer, $settings.composerDisplay)}</span>
				</div>
				{#if sequenceLabel}<div
						class="sequence-controls"
						aria-label="Concert program navigation">
						<button
							class="icon-button"
							aria-label="Previous score in list"
							title="Previous score in list"
							disabled={!onPreviousScore || switchingScore}
							onclick={() => void switchProgram(onPreviousScore)}
							><ChevronLeft size={15} /></button
						><span class="sequence-full" title={sequenceLabel}
							>{sequenceLabel}</span
						><span class="sequence-short" title={sequenceLabel}
							>{sequenceLabel.split('·').at(-1)?.trim()}</span
						><button
							class="icon-button"
							aria-label="Next score in list"
							title="Next score in list"
							disabled={!onNextScore || switchingScore}
							onclick={() => void switchProgram(onNextScore)}
							><ChevronRight size={15} /></button>
					</div>{/if}
			</div>
			<div class="page-controls">
				<button
					class="icon-button"
					title="Previous page"
					aria-label="Previous page"
					onclick={previous}
					disabled={page <= 1}><ChevronLeft size={19} /></button>
				<input
					aria-label="Page number"
					bind:value={pageInput}
					onkeydown={(e) => e.key === 'Enter' && goToPage()}
					onblur={goToPage} />
				<span>/ {pdf?.numPages ?? score.totalPages}</span>
				<button
					class="icon-button"
					title="Next page"
					aria-label="Next page"
					onclick={next}
					disabled={!pdf || page >= pdf.numPages}
					><ChevronRight size={19} /></button>
			</div>
			<div class="topbar-right" role="toolbar" aria-label="Score tools">
				<button
					class="icon-button"
					class:active={controls}
					title="Annotate (P)"
					aria-label="Annotation tools"
					aria-pressed={controls}
					onclick={toggleControls}><Pencil size={18} /></button>
				<button
					class="icon-button"
					class:active={layersOpen}
					title="Annotation layers"
					aria-label="Annotation layers"
					aria-expanded={layersOpen}
					onclick={() => {
						layersOpen = !layersOpen;
						practicePanel = null;
						searchOpen = false;
					}}><Layers size={18} /></button>
				<span class="toolbar-divider"></span>
				<button
					class="icon-button tool-indicator"
					class:active={practicePanel === 'metronome'}
					class:running={practiceState.metronome}
					title="Metronome"
					aria-label="Metronome"
					aria-expanded={practicePanel === 'metronome'}
					onclick={() => togglePractice('metronome')}
					><Metronome size={19} />{#if practiceState.metronome}<i></i
						>{/if}</button>
				<button
					class="icon-button tool-indicator"
					class:active={practicePanel === 'tuner'}
					class:running={practiceState.tuner}
					title="Tuner"
					aria-label="Tuner"
					aria-expanded={practicePanel === 'tuner'}
					onclick={() => togglePractice('tuner')}
					><AudioLines size={19} />{#if practiceState.tuner}<i></i
						>{/if}</button>
				<span class="toolbar-divider"></span>
				<button
					class="icon-button"
					class:active={searchOpen}
					title="Find in score"
					aria-label="Find in score"
					aria-expanded={searchOpen}
					onclick={() => {
						searchOpen = !searchOpen;
						layersOpen = false;
						practicePanel = null;
					}}><Search size={18} /></button>
				<button
					class="icon-button"
					class:active={bookmarked}
					title={bookmarked ? 'Remove bookmark' : 'Bookmark score'}
					aria-label={bookmarked ? 'Remove bookmark' : 'Bookmark score'}
					onclick={toggleBookmark}
					>{#if bookmarked}<BookmarkCheck size={18} />{:else}<Bookmark
							size={18} />{/if}</button>
				<button
					class="icon-button"
					title="Hide interface (F)"
					aria-label="Hide interface"
					onclick={enterReading}><PanelTopClose size={18} /></button>
			</div>
		</header>
	{:else}
		<button
			class="reading-exit"
			title="Show interface (F)"
			aria-label="Show interface"
			onclick={exitReading}><PanelTopOpen size={18} /></button>
	{/if}

	{#if !reading}
		<footer class="bottombar" aria-label="View controls">
			<button
				class="icon-button"
				title="Zoom out"
				aria-label="Zoom out"
				onclick={() => setZoom(zoom - 0.08)}><ZoomOut size={17} /></button>
			<button
				class="zoom-reset"
				title="Reset zoom"
				aria-label="Reset zoom to 100%"
				onclick={() => {
					needsCenter = true;
					setZoom(1, { immediate: true });
				}}>{Math.round(zoom * 100)}<span>%</span></button>
			<button
				class="icon-button"
				title="Zoom in"
				aria-label="Zoom in"
				onclick={() => setZoom(zoom + 0.08)}><ZoomIn size={17} /></button>
			<span class="toolbar-divider"></span>
			<button
				class="icon-button"
				class:active={fit === 'page'}
				title="Fit entire page"
				aria-label="Fit entire page"
				onclick={() => setFit('page')}><Scan size={17} /></button>
			<button
				class="icon-button"
				class:active={fit === 'width'}
				title="Fit page width"
				aria-label="Fit page width"
				onclick={() => setFit('width')}><StretchHorizontal size={18} /></button>
			<button
				class="icon-button"
				class:active={dual}
				title={dual ? 'Switch to single page' : 'Switch to two pages'}
				aria-label={dual ? 'Switch to single page' : 'Switch to two pages'}
				onclick={() => {
					autoLayout = false;
					dual = !dual;
					persistPrefs();
					void render({ quiet: hasPainted });
				}}><Columns2 size={17} /></button>
			<span class="toolbar-divider"></span>
			<button
				class="icon-button"
				title={annotationsVisible ? 'Hide annotations' : 'Show annotations'}
				aria-label={annotationsVisible
					? 'Hide annotations'
					: 'Show annotations'}
				aria-pressed={annotationsVisible}
				onclick={toggleAnnotations}
				>{#if annotationsVisible}<Eye size={17} />{:else}<EyeOff
						size={17} />{/if}</button>
			<button
				class="icon-button"
				title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
				aria-label={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}
				onclick={toggleFullScreen}
				>{#if isFullscreen}<Minimize2 size={17} />{:else}<Maximize2
						size={17} />{/if}</button>
			<button
				class="icon-button"
				title="Viewer settings"
				aria-label="Viewer settings"
				onclick={() => (settingsOpen = !settingsOpen)}
				><Settings2 size={17} /></button>
		</footer>
	{/if}
	{#if !reading && layersOpen}<AnnotationLayersPanel
			{layers}
			{activeLayer}
			error={layerError}
			onSelect={(id) => {
				activeLayer = id;
			}}
			onRename={(id, name) => {
				layers = layers.map((l) => (l.id === id ? { ...l, name } : l));
				saveLayers();
			}}
			onVisibility={(id) => {
				layers = layers.map((l) =>
					l.id === id ? { ...l, visible: !l.visible } : l
				);
				saveLayers();
			}}
			onMove={moveLayer}
			onAdd={addLayer}
			onClose={() => (layersOpen = false)} />{/if}
	<div hidden={reading}>
		<PracticeTools
			panel={practicePanel}
			onClose={() => (practicePanel = null)}
			onStateChange={(state) => (practiceState = state)} />
	</div>
	{#if searchOpen && !reading}<div class="search-panel">
			<Search size={17} /><input
				bind:value={searchText}
				placeholder="Find text in this score…"
				onkeydown={(e) => e.key === 'Enter' && searchPdf()} />
			<button class="text-button" onclick={searchPdf}>Find</button>
			<span>{searchStatus}</span>
			<button
				class="icon-button"
				aria-label="Close search"
				onclick={() => (searchOpen = false)}><X size={17} /></button>
		</div>{/if}

	<main
		class="workspace"
		bind:this={workspace}
		class:fit-page={fit === 'page'}
		class:is-panning={!!panDrag}
		class:is-annotating={annotating}
		onwheel={onWheel}
		onpointerdown={onWorkspacePointerDown}
		onpointermove={onWorkspacePointerMove}
		onpointerup={onWorkspacePointerUp}
		onpointercancel={onWorkspacePointerUp}>
		<div
			class="pages"
			class:dual
			class:transitioning={pageTransition}
			style={`transform: translate3d(${panX}px, ${panY}px, 0) scale(${zoom}); transform-origin: 0 0`}>
			<div class="page-shell">
				<canvas class="pdf-canvas" bind:this={leftPdf}></canvas>
				<canvas
					class="ink-canvas"
					class:interactive={annotating}
					class:eraser-mode={tool === 'eraser'}
					class:symbol-mode={tool === 'symbol'}
					bind:this={leftInk}
					onpointerdown={(event) => begin(event, visiblePages[0], leftInk!)}
					onpointermove={move}
					onpointerup={end}
					onpointercancel={end}
					onpointerleave={onInkPointerLeave}></canvas>
			</div>
			{#if dual && visiblePages.length > 1}
				<div class="page-shell">
					<canvas class="pdf-canvas" bind:this={rightPdf}></canvas>
					<canvas
						class="ink-canvas"
						class:interactive={annotating}
						class:eraser-mode={tool === 'eraser'}
						class:symbol-mode={tool === 'symbol'}
						bind:this={rightInk}
						onpointerdown={(event) => begin(event, visiblePages[1], rightInk!)}
						onpointermove={move}
						onpointerup={end}
						onpointercancel={end}
						onpointerleave={onInkPointerLeave}></canvas>
				</div>
			{/if}
		</div>
		{#if !hasPainted && page === 1 && score.thumbnailUrl && !error}
			<img
				class="opening-preview"
				src={score.thumbnailUrl}
				alt=""
				aria-hidden="true" />
		{/if}
		{#if loading && !hasPainted}
			<div class="loading"><span></span><span>{loadingText}</span></div>
		{/if}
		{#if loading && hasPainted}
			<div class="loading subtle"><span></span></div>
		{/if}
		{#if error}
			<div class="error">
				<strong>Unable to display this score</strong><span>{error}</span>
				<button onclick={() => void load()}>Retry</button>
			</div>
		{/if}
	</main>

	<button
		class="page-hit left-hit"
		aria-label="Previous page"
		onclick={previous}
		disabled={page <= 1 || !!textEditor || annotating}></button>
	<button
		class="page-hit right-hit"
		aria-label="Next page"
		onclick={next}
		disabled={!pdf ||
			page >= (pdf?.numPages ?? 1) ||
			!!textEditor ||
			annotating}></button>

	{#if textEditor}
		<div
			class="text-editor-floating"
			role="dialog"
			aria-labelledby="text-editor-title"
			style={`left:${textEditor.screenX ?? 24}px;top:${textEditor.screenY ?? 120}px`}
			onpointerdown={(e) => e.stopPropagation()}
			tabindex="-1">
			<span class="text-editor-label">Note</span>
			<input
				data-score-text-input
				bind:value={textDraft}
				placeholder="Write a note…"
				onkeydown={(e) => {
					if (e.key === 'Enter') {
						e.preventDefault();
						commitText();
					} else if (e.key === 'Escape') {
						e.preventDefault();
						cancelText();
					}
				}} />
			<button
				type="button"
				class="text-editor-save"
				title="Save"
				onclick={commitText}><Check size={15} /></button>
			<button type="button" title="Cancel" onclick={cancelText}
				><X size={15} /></button>
		</div>
	{/if}

	{#if !reading && controls && tool === 'handwriting'}
		<div class="handwriting-status">
			<select
				aria-label="Handwriting recognition mode"
				value={handwritingMode}
				onchange={(event) => { handwritingMode = event.currentTarget.value as RecognitionMode; clearTimeout(handwritingTimer); handwritingEpoch++; if (handwritingBatch) retryHandwriting(); }}
				><option value="auto">Auto</option><option value="music"
					>Music symbols</option
				><option value="text">Text</option></select
			><span role="status">{handwritingStatus}</span>
			{#if handwritingRetryAvailable}<button onclick={retryHandwriting}
					>Retry conversion</button
				>{/if}<button onclick={() => (handwritingSetupOpen = true)}
				>Model setup</button>
		</div>
	{/if}
	{#if !reading && controls}
		<div
			class="palette"
			class:is-away={paletteAway}
			class:symbol-open={tool === 'symbol' && !symbolSheetCollapsed}>
			<aside class="tool-rail" aria-label="Annotation tools">
				<span
					class="layer-chip"
					title={layers.find((l) => l.id === activeLayer)?.name}
					>{layers.find((l) => l.id === activeLayer)?.name}</span
				>{#if !layers.some((l) => l.id === activeLayer && l.visible)}<span
						class="layer-chip">Hidden layer</span
					>{/if}
				<div class="rail-group" role="toolbar" aria-label="Draw">
					<button
						type="button"
						class="rail-btn"
						class:active={tool === 'handwriting'}
						data-tool="handwriting"
						title="Handwriting: automatically convert symbols and text"
						aria-label="Handwriting"
						onclick={() => choose('handwriting')}>
						<PenLine size={18} />
					</button>
					<button
						type="button"
						class:active={tool === 'pen'}
						class="rail-btn"
						data-tool="pen"
						title="Pen (P)"
						aria-label="Pen"
						onclick={() => choose('pen')}><PenTool size={18} /></button>
					<button
						type="button"
						class:active={tool === 'highlighter'}
						class="rail-btn"
						data-tool="highlighter"
						title="Highlighter (H)"
						aria-label="Highlighter"
						onclick={() => choose('highlighter')}
						><Highlighter size={18} /></button>
					<button
						type="button"
						class:active={tool === 'line'}
						class="rail-btn"
						data-tool="line"
						title="Line"
						aria-label="Line"
						onclick={() => choose('line')}><Minus size={18} /></button>
					<button
						type="button"
						class:active={tool === 'arrow'}
						class="rail-btn"
						data-tool="arrow"
						title="Arrow"
						aria-label="Arrow"
						onclick={() => choose('arrow')}><ArrowUpRight size={18} /></button>
					<button
						type="button"
						class:active={tool === 'eraser'}
						class="rail-btn"
						data-tool="eraser"
						title="Eraser (E)"
						aria-label="Eraser"
						onclick={() => choose('eraser')}><Eraser size={18} /></button>
				</div>
				<div class="rail-sep" aria-hidden="true"></div>
				<div class="rail-group" role="toolbar" aria-label="Place">
					<button
						type="button"
						class:active={tool === 'symbol'}
						class="rail-btn"
						data-tool="symbol"
						title="Symbols (S)"
						aria-label="Symbols"
						onclick={() => choose('symbol')}>
						{#if tool === 'symbol'}
							<span class="rail-glyph" aria-hidden="true"
								>{selectedSymbol.glyph}</span>
						{:else}
							<Music2 size={18} />
						{/if}
					</button>
					<button
						type="button"
						class:active={tool === 'text'}
						class="rail-btn"
						data-tool="text"
						title="Text (T)"
						aria-label="Text"
						onclick={() => choose('text')}><Type size={18} /></button>
				</div>
				<div class="rail-sep" aria-hidden="true"></div>
				<div class="rail-group" role="toolbar" aria-label="History">
					<button
						type="button"
						class="rail-btn"
						title="Undo"
						aria-label="Undo"
						disabled={!canUndo}
						onclick={undo}><Undo2 size={18} /></button>
					<button
						type="button"
						class="rail-btn"
						title="Redo"
						aria-label="Redo"
						disabled={!canRedo}
						onclick={redo}><Redo2 size={18} /></button>
				</div>
				<div class="rail-sep" aria-hidden="true"></div>
				<button
					type="button"
					class="rail-btn rail-close"
					title="Close tools"
					aria-label="Close annotation tools"
					onclick={toggleControls}><X size={17} /></button>
			</aside>

			{#if showToolOptions}
				<div class="tool-options" role="group" aria-label="Tool options">
					{#if strokeTool}
						<div class="opt-colors">
							{#each colors as swatch}
								<button
									type="button"
									class="swatch"
									class:selected={color === swatch}
									style={`--swatch:${swatch}`}
									title={swatch}
									onclick={() => (color = swatch)}></button>
							{/each}
						</div>
						<label class="opt-size">
							<span class="opt-size-val">{width}</span>
							<input
								type="range"
								min="1"
								max="14"
								bind:value={width}
								aria-label="Stroke size" />
						</label>
					{:else if tool === 'eraser'}
						<label class="opt-size">
							<span class="opt-size-val">{width}</span>
							<input
								type="range"
								min="1"
								max="14"
								bind:value={width}
								aria-label="Eraser size" />
						</label>
					{/if}
				</div>
			{/if}

			{#if tool === 'symbol'}
				{#if symbolSheetCollapsed}
					<button
						type="button"
						class="symbol-chip"
						title="Open symbol picker"
						aria-label="Open symbol picker"
						onclick={() => (symbolSheetCollapsed = false)}>
						<span class="symbol-chip-glyph">{selectedSymbol.glyph}</span>
						<span class="symbol-chip-meta">
							<strong>{selectedSymbol.name}</strong>
							<span>Tap to change · click score to place</span>
						</span>
					</button>
				{:else}
					<div class="symbol-drawer" role="dialog" aria-label="Musical symbols">
						<header class="symbol-drawer-head">
							<div class="symbol-drawer-title">
								<strong>Symbols</strong>
								<span>Select, then click the score</span>
							</div>
							<div class="symbol-drawer-actions">
								<button
									type="button"
									class="icon-button"
									title="Minimize"
									aria-label="Minimize symbol picker"
									onclick={() => (symbolSheetCollapsed = true)}
									><Minus size={16} /></button>
								<!-- <button type="button" class="icon-button" title="Close symbols" aria-label="Close symbols" onclick={() => choose('pen')}><X size={16} /></button> -->
							</div>
						</header>

						<div class="symbol-search-row">
							<input
								bind:value={symbolSearch}
								placeholder="Search symbols…"
								aria-label="Search symbols" />
							<label class="symbol-size-control" title="Placement size">
								<span>{symbolSize}px</span>
								<input type="range" min="20" max="64" bind:value={symbolSize} />
							</label>
						</div>

						<nav class="symbol-cats" aria-label="Symbol categories">
							<button
								type="button"
								class:active={symbolCategory === 'Recent' &&
									!symbolSearch.trim()}
								onclick={() => {
									symbolCategory = 'Recent';
									symbolSearch = '';
								}}>Recent</button>
							{#each MUSIC_SYMBOL_CATEGORIES as category}
								<button
									type="button"
									class:active={symbolCategory === category &&
										!symbolSearch.trim()}
									onclick={() => {
										symbolCategory = category;
										symbolSearch = '';
									}}>{category}</button>
							{/each}
						</nav>

						<div class="symbol-tray">
							{#each filteredSymbols as symbol (symbol.id)}
								<button
									type="button"
									class="symbol-tile"
									class:selected={selectedSymbol.id === symbol.id}
									title={symbol.name}
									onclick={() => {
										selectedSymbol = symbol;
									}}>
									<span class="glyph-box"
										><span class="glyph">{symbol.glyph}</span></span>
									<span class="name">{symbol.name}</span>
								</button>
							{:else}
								<p class="symbol-empty">
									{symbolSearch.trim()
										? `No symbols match “${symbolSearch}”`
										: 'No recent symbols yet — pick a category'}
								</p>
							{/each}
						</div>
					</div>
				{/if}
			{/if}
		</div>
	{/if}

	{#if cursorScreen && tool === 'eraser' && !reading}
		<div
			class="eraser-cursor"
			style={`left:${cursorScreen.x}px;top:${cursorScreen.y}px;--eraser-size:${Math.max(14, width * 1.8)}px`}
			aria-hidden="true">
		</div>
	{/if}
	{#if cursorScreen && tool === 'symbol' && !reading}
		<div
			class="symbol-ghost"
			style={`left:${cursorScreen.x}px;top:${cursorScreen.y}px;--ghost-size:${symbolSize * zoom}px;--ghost-color:${color}`}
			aria-hidden="true">
			<span class="symbol-ghost-ring"></span>
			<span class="symbol-ghost-glyph">{selectedSymbol.glyph}</span>
		</div>
	{/if}

	{#if settingsOpen && !reading}
		<SettingsPanel
			open={settingsOpen}
			focusSection="viewer"
			onClose={() => {
				settingsOpen = false;
				persistPrefs();
				void render({ quiet: hasPainted });
			}} />
	{/if}
</div>

<HandwritingSetup
	pauseMs={handwritingPauseMs}
	onPauseChange={(value) => {
		handwritingPauseMs = value;
		try {
			localStorage.setItem('sonora-handwriting-pause-ms', String(value));
		} catch {}
	}}
	bind:open={handwritingSetupOpen}
	onReady={() => {
		handwritingStatus = 'Offline model ready. Write on the score.';
	}} />

<style>
	.handwriting-status {
		position: absolute;
		left: 76px;
		bottom: 18px;
		max-width: min(420px, calc(100% - 100px));
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 10px 14px;
		background: var(--sonora-bg-panel-solid);
		border: 1px solid var(--sonora-border-strong);
		border-radius: 12px;
		font:
			12px/1.4 system-ui,
			sans-serif;
		color: var(--sonora-text-muted);
		z-index: 20;
	}
	.handwriting-status select {
		max-width: 115px;
		color: var(--sonora-text);
		background: var(--sonora-bg-panel-solid);
		border: 1px solid var(--sonora-border-strong);
		border-radius: 6px;
		padding: 4px;
		font: inherit;
	}
	.handwriting-status button {
		flex-shrink: 0;
		background: transparent;
		border: 0;
		color: var(--sonora-accent);
		font: inherit;
		cursor: pointer;
	}
	.toolbar-divider {
		height: 18px;
		width: 1px;
		background: var(--sonora-border-strong);
		margin: 0 5px;
		flex-shrink: 0;
	}
	.topbar {
		height: 64px;
		box-sizing: border-box;
		padding: 0 18px !important;
		display: grid !important;
		grid-template-columns: minmax(0, 1fr) auto minmax(0, 1fr);
		gap: 16px;
		background: var(--sonora-bg-header) !important;
	}
	.topbar-left {
		min-width: 0;
	}
	.score-title {
		min-width: 0;
		max-width: 260px;
	}
	.topbar-right {
		justify-content: flex-end;
		gap: 2px !important;
		white-space: nowrap;
	}
	.topbar .icon-button,
	.bottombar .icon-button {
		width: 34px;
		height: 34px;
		border-radius: 8px;
		flex-shrink: 0;
	}
	.topbar .icon-button {
		color: var(--sonora-text-secondary);
	}
	.icon-button.active {
		background: var(--sonora-accent-soft) !important;
		color: var(--sonora-accent) !important;
	}
	.tool-indicator {
		position: relative;
	}
	.tool-indicator i {
		position: absolute;
		width: 4px;
		height: 4px;
		bottom: 3px;
		left: calc(50% - 2px);
		border-radius: 50%;
		background: var(--sonora-accent);
	}
	.bottombar {
		position: absolute !important;
		top: auto !important;
		bottom: 18px;
		left: 50% !important;
		transform: translateX(-50%);
		width: auto !important;
		display: flex !important;
		align-items: center;
		gap: 2px;
		padding: 5px 8px !important;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 13px;
		background: var(--sonora-bg-panel);
		box-shadow: 0 4px 24px #0002;
		backdrop-filter: blur(18px);
	}
	.zoom-reset {
		min-width: 48px !important;
		font-size: 11px;
	}
	.zoom-reset span {
		font-size: 9px;
		color: var(--sonora-text-muted);
		margin-left: 1px;
	}
	.workspace {
		inset: 64px 0 0 !important;
	}
	.viewer.reading .workspace {
		inset: 0 !important;
	}
	.page-controls {
		gap: 3px !important;
	}
	.page-controls input {
		border-color: transparent !important;
		background: var(--sonora-bg-hover) !important;
		width: 34px !important;
		font-size: 11px;
	}
	.page-controls > span {
		font-size: 10px;
	}
	.layer-chip {
		font-size: 9px;
		max-width: 40px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--sonora-text-muted);
	}
	.rail-btn {
		width: 36px !important;
		height: 36px !important;
	}
	.tool-rail {
		border-radius: 13px !important;
		gap: 3px !important;
		padding: 7px 5px !important;
	}
	.reading-exit {
		padding: 10px !important;
		opacity: 0.7;
	}
	.search-panel {
		top: 76px !important;
		right: 16px !important;
		left: auto !important;
		transform: none !important;
		width: min(440px, calc(100% - 32px));
	}
	.palette {
		top: calc(50% + 20px) !important;
	}
	.viewer {
		font-family: var(--sonora-font-ui, Inter, system-ui, sans-serif);
	}
	@media (max-width: 900px) {
		.topbar {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: 5px;
		}
		.page-controls {
			grid-column: 1;
			grid-row: 2;
			justify-content: flex-start !important;
		}
		.topbar-right {
			grid-column: 2;
			grid-row: 1 / 3;
		}
		.topbar {
			height: 88px;
			padding: 8px 12px !important;
		}
		.score-title strong {
			font-size: 12px;
		}
		.score-title span {
			font-size: 9px;
		}
		.workspace {
			inset: 88px 0 0 !important;
		}
		.topbar .icon-button {
			width: 30px;
			height: 32px;
		}
		.toolbar-divider {
			margin: 0 3px;
		}
		.bottombar {
			bottom: 12px;
			max-width: calc(100% - 24px);
		}
		.bottombar .icon-button {
			width: 30px;
		}
	}

	.sequence-short {
		display: none;
	}
	.topbar-left {
		min-width: 0;
	}
	@media (max-width: 900px) {
		.sequence-full {
			display: none;
		}
		.sequence-short {
			display: inline;
		}
	}
	.sequence-controls {
		display: flex;
		align-items: center;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-sm);
		background: var(--sonora-surface-raised);
	}
	.sequence-controls span {
		font-size: var(--sonora-text-sm);
		max-width: 130px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	@font-face {
		font-family: Leland;
		src:
			url('/fonts/Leland.otf') format('opentype'),
			url('/Leland.otf') format('opentype');
		font-display: swap;
	}
	.viewer {
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 0;
		overflow: hidden;
		background: var(--sonora-bg, #11110f);
		color: var(--sonora-text, #f4f4f0);
		font-family: var(
			--sonora-font,
			Inter,
			ui-sans-serif,
			system-ui,
			sans-serif
		);
	}
	.topbar {
		position: relative;
		z-index: 30;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 9px 14px;
		background: var(--sonora-surface-glass);
		border-bottom: 1px solid var(--sonora-border-strong);
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
	}
	.bottombar {
		position: relative;
		top: 8px;
		left: 8px;
		width: calc(100% - 16px);
		display: flex;
		justify-content: space-between;
		z-index: 30;
	}

	.topbar-left,
	.topbar-right,
	.page-controls {
		display: flex;
		align-items: center;
		gap: 5px;
	}
	.topbar-left,
	.topbar-right {
		flex: 1;
	}
	.topbar-right {
		justify-content: flex-end;
	}
	.score-title {
		min-width: 0;
		display: flex;
		flex-direction: column;
	}
	.score-title strong {
		max-width: 42vw;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		font-size: 13px;
	}
	.score-title span {
		color: var(--sonora-text-muted);
		font-size: 10px;
		margin-top: 2px;
	}
	.page-controls {
		justify-content: center;
	}
	.icon-button,
	.text-button {
		border: 1px solid transparent;
		background: transparent;
		color: var(--sonora-text-muted);
		border-radius: 9px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.icon-button {
		width: var(--sonora-control-size);
		height: var(--sonora-control-size);
	}
	.icon-button:hover,
	.text-button:hover,
	.icon-button.active {
		background: var(--sonora-border-strong);
		color: var(--sonora-text);
	}
	.icon-button:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}
	.zoom-reset {
		min-width: 48px;
		height: 36px;
		padding: 0 8px;
		border: 1px solid transparent;
		border-radius: 9px;
		background: transparent;
		color: var(--sonora-text);
		font-size: 12px;
		font-variant-numeric: tabular-nums;
		font-weight: 500;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.zoom-reset:hover {
		background: var(--sonora-border-strong);
		color: var(--sonora-text);
	}
	.text-button {
		min-height: 36px;
		padding: 7px 10px;
		gap: 5px;
		font-size: 11px;
		animation: settings-in 160ms cubic-bezier(0.2, 0.8, 0.2, 1);
	}
	.page-controls input {
		width: 48px;
		height: 34px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 9px;
		background: var(--sonora-bg-deep);
		color: var(--sonora-text);
		text-align: center;
		outline: none;
	}
	.page-controls span {
		color: var(--sonora-text-muted);
		font-size: 11px;
	}
	.workspace {
		position: absolute;
		inset: 56px 0 8px;
		overflow: hidden; /* pan via transform — avoids janky overflow scroll */
		scrollbar-width: none;
		-ms-overflow-style: none;
		display: flex;
		justify-content: center;
		align-items: flex-start;
		padding: 28px;
		background: var(
			--sonora-bg-workspace,
			radial-gradient(circle at 50% 18%, #292923 0, #151512 48%, #0f0f0d 100%)
		);
		overscroll-behavior: none;
		touch-action: none;
		cursor: grab;
		user-select: none;
	}
	.workspace.is-panning {
		cursor: grabbing;
	}
	.workspace.is-annotating {
		cursor: default;
	}
	.workspace.fit-page {
		align-items: center;
	}
	.workspace::-webkit-scrollbar {
		display: none;
	}

	.pages {
		position: absolute;
		left: 0;
		top: 0;
		display: flex;
		align-items: flex-start;
		justify-content: center;
		gap: 20px;
		min-width: max-content;
		will-change: transform;
		backface-visibility: hidden;
		transform-origin: 0 0;
	}
	.pages.dual {
		gap: 0;
	}
	.pages.transitioning .page-shell {
		opacity: 0.72;
		transition: opacity 90ms ease;
	}
	.pages.dual .page-shell {
		box-shadow: 0 18px 55px rgba(0, 0, 0, 0.42);
	}
	/* Realistic inner-page gutter gradients (book-like) */
	.pages.dual .page-shell::after {
		content: '';
		position: absolute;
		top: 0;
		bottom: 0;
		width: 28px;
		pointer-events: none;
		z-index: 2;
	}
	.pages.dual .page-shell:first-child::after {
		right: 0;
		background: linear-gradient(
			to right,
			rgba(0, 0, 0, 0) 0%,
			rgba(0, 0, 0, 0.04) 35%,
			rgba(0, 0, 0, 0.14) 70%,
			rgba(0, 0, 0, 0.28) 100%
		);
	}
	.pages.dual .page-shell:last-child::after {
		left: 0;
		background: linear-gradient(
			to left,
			rgba(0, 0, 0, 0) 0%,
			rgba(0, 0, 0, 0.04) 35%,
			rgba(0, 0, 0, 0.14) 70%,
			rgba(0, 0, 0, 0.28) 100%
		);
	}
	.page-shell {
		position: relative;
		flex: 0 0 auto;
		background: #fff;
		box-shadow: 0 18px 55px rgba(0, 0, 0, 0.42);
		will-change: opacity, transform;
		transition: opacity 140ms ease;
	}
	.pdf-canvas,
	.ink-canvas {
		display: block;
	}
	.ink-canvas {
		position: absolute;
		inset: 0;
		touch-action: none;
		pointer-events: none;
	}
	.ink-canvas.interactive {
		pointer-events: auto;
		cursor: crosshair;
	}
	.ink-canvas.interactive.eraser-mode {
		cursor: none;
	}
	.ink-canvas.interactive.symbol-mode {
		cursor: none;
	}
	.eraser-cursor {
		position: fixed;
		z-index: 80;
		width: var(--eraser-size, 24px);
		height: var(--eraser-size, 24px);
		margin-left: calc(var(--eraser-size, 24px) / -2);
		margin-top: calc(var(--eraser-size, 24px) / -2);
		border-radius: 50%;
		border: 1.5px solid rgba(248, 113, 113, 0.95);
		background: rgba(248, 113, 113, 0.12);
		box-shadow:
			0 0 0 1px rgba(0, 0, 0, 0.35),
			inset 0 0 8px rgba(248, 113, 113, 0.25);
		pointer-events: none;
		mix-blend-mode: normal;
	}
	/* WYSIWYG symbol ghost — true size at cursor, click to stamp */
	.symbol-ghost {
		position: fixed;
		z-index: 80;
		left: 0;
		top: 0;
		width: 0;
		height: 0;
		pointer-events: none;
		transform: translate(0, 0);
	}
	.symbol-ghost-ring {
		position: absolute;
		left: 0;
		top: 0;
		width: 28px;
		height: 28px;
		margin-left: -14px;
		margin-top: -14px;
		border-radius: 50%;
		border: 1.5px solid rgba(167, 139, 250, 0.75);
		background: rgba(124, 58, 237, 0.08);
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
	}
	.symbol-ghost-glyph {
		position: absolute;
		left: 0;
		top: 0;
		transform: translate(-50%, -50%);
		font-family: Leland, serif;
		font-size: var(--ghost-size, 34px);
		line-height: 1;
		color: var(--ghost-color, #111827);
		opacity: 0.55;
		/* Soft outline so the ghost reads on dark/light score paper */
		text-shadow:
			0 0 2px rgba(255, 255, 255, 0.85),
			0 1px 2px rgba(0, 0, 0, 0.2);
		user-select: none;
	}
	.page-hit {
		position: absolute;
		z-index: 15;
		top: 56px;
		bottom: 8px;
		width: 25vw;
		border: 0;
		background: transparent;
		opacity: 0;
		cursor: pointer;
		-webkit-tap-highlight-color: transparent;
		touch-action: manipulation;
	}
	.page-hit:disabled {
		pointer-events: none;
	}
	.left-hit {
		left: 0;
	}
	.right-hit {
		right: 0;
	}
	.opening-preview {
		position: absolute;
		inset: 5%;
		width: 90%;
		height: 90%;
		object-fit: contain;
		pointer-events: none;
	}
	.loading,
	.error {
		position: absolute;
		z-index: 50;
		left: 50%;
		top: 50%;
		transform: translate(-50%, -50%);
		display: flex;
		flex-direction: column;
		align-items: center;
		padding: 14px 18px;
		font-size: 12px;
		color: var(--sonora-text-muted);
		box-shadow: 0 18px 50px rgba(0, 0, 0, 0.42);
		border: 1px solid var(--sonora-border-strong);
		border-radius: 14px;
		background: var(--sonora-surface-glass);
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
	}

	.loading.subtle {
		padding: 8px;
		background: var(--sonora-surface-glass);
		box-shadow: none;
		pointer-events: none;
	}
	.loading span:first-child {
		width: 18px;
		height: 18px;
		border: 2px solid var(--sonora-border-strong);
		border-top-color: var(--sonora-text);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	.error strong {
		color: var(--sonora-text);
	}
	.error span {
		max-width: 360px;
		text-align: center;
		line-height: 1.45;
	}
	.error button {
		border: 0;
		border-radius: 8px;
		padding: 7px 11px;
		cursor: pointer;
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
	}
	/* —— Annotation palette (redesign) —— */
	.palette {
		position: absolute;
		z-index: 36;
		left: 12px;
		top: 50%;
		transform: translateY(-50%);
		display: flex;
		align-items: center;
		gap: 8px;
		pointer-events: none;
		transition:
			opacity 160ms ease,
			transform 180ms ease;
	}
	.palette > * {
		pointer-events: auto;
	}
	/* While drawing, step fully aside so placement under the rail is frictionless */
	.palette.is-away {
		opacity: 0.12;
		transform: translateY(-50%) translateX(-12px);
		pointer-events: none;
	}
	.palette.is-away > * {
		pointer-events: none;
	}

	.tool-rail {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 4px;
		padding: 8px 6px;
		border-radius: 18px;
		border: 1px solid var(--sonora-border-strong);
		background: var(--sonora-surface-glass);
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
		box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
	}
	.rail-group {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 2px;
	}
	.rail-sep {
		width: 22px;
		height: 1px;
		margin: 3px 0;
		background: var(--sonora-border-strong);
	}
	.rail-btn {
		flex-shrink: 0;
		padding: 0;
		line-height: 1;
		width: 40px;
		height: 40px;
		border: 1px solid transparent;
		border-radius: 12px;
		background: transparent;
		color: var(--sonora-text-muted);
		display: grid;
		place-items: center;
		cursor: pointer;
		transition:
			background 120ms ease,
			color 120ms ease,
			box-shadow 120ms ease;
	}
	.rail-btn:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.07);
		color: var(--sonora-text);
	}
	.rail-btn:disabled {
		opacity: 0.28;
		cursor: not-allowed;
	}
	.rail-btn.active {
		color: var(--sonora-text);
		background: color-mix(
			in srgb,
			var(--tool-accent, #3b82f6) 30%,
			transparent
		);
		box-shadow: inset 0 0 0 1px
			color-mix(in srgb, var(--tool-accent, #3b82f6) 55%, transparent);
	}
	.rail-btn :global(svg) {
		display: block;
		width: 18px;
		height: 18px;
		flex-shrink: 0;
	}
	.rail-btn[data-tool='handwriting'] {
		--tool-accent: var(--sonora-accent);
	}
	.rail-btn[data-tool='pen'] {
		--tool-accent: #f59e0b;
	}
	.rail-btn[data-tool='highlighter'] {
		--tool-accent: #eab308;
	}
	.rail-btn[data-tool='line'] {
		--tool-accent: #38bdf8;
	}
	.rail-btn[data-tool='arrow'] {
		--tool-accent: #22d3ee;
	}
	.rail-btn[data-tool='eraser'] {
		--tool-accent: #f87171;
	}
	.rail-btn[data-tool='symbol'] {
		--tool-accent: #a78bfa;
	}
	.rail-btn[data-tool='text'] {
		--tool-accent: #4ade80;
	}
	.rail-close {
		margin-top: 1px;
	}
	.rail-glyph {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 26px;
		height: 26px;
		overflow: hidden;
		font:
			20px/1 Leland,
			serif;
		color: var(--sonora-text);
	}

	.tool-options {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 10px 12px;
		border-radius: 16px;
		border: 1px solid var(--sonora-border-strong);
		background: var(--sonora-surface-glass);
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.42);
		max-width: 56px;
	}
	.opt-colors {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 7px;
	}
	.opt-colors .swatch {
		width: 22px;
		height: 22px;
		border: 2px solid transparent;
		border-radius: 50%;
		background: var(--swatch);
		cursor: pointer;
		flex-shrink: 0;
		padding: 0;
	}
	.opt-colors .swatch.selected {
		border-color: var(--sonora-text);
		box-shadow: 0 0 0 1px #111;
	}
	.opt-size {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
		color: var(--sonora-text-muted);
		font-size: 10px;
	}
	.opt-size-val {
		min-width: 14px;
		text-align: center;
		color: var(--sonora-text);
		font-variant-numeric: tabular-nums;
		font-weight: 600;
	}
	.opt-size input[type='range'] {
		-webkit-appearance: none;
		appearance: none;
		writing-mode: vertical-lr;
		direction: rtl;
		width: 4px;
		height: 72px;
		border-radius: 999px;
		background: linear-gradient(
			180deg,
			rgba(255, 255, 255, 0.28),
			var(--sonora-border-strong)
		);
		outline: none;
		cursor: pointer;
		padding: 0;
	}
	.opt-size input[type='range']::-webkit-slider-thumb {
		-webkit-appearance: none;
		appearance: none;
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #f4f4f0;
		border: 2px solid #1a1a17;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
		cursor: pointer;
	}
	.opt-size input[type='range']::-moz-range-thumb {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #f4f4f0;
		border: 2px solid #1a1a17;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
		cursor: pointer;
	}

	/* Collapsed symbol chip — sits under the tool rail */
	.symbol-chip {
		position: absolute;
		left: 0;
		top: calc(100% + 8px);
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 168px;
		max-width: min(240px, 52vw);
		padding: 8px 12px 8px 10px;
		border-radius: 14px;
		border: 1px solid var(--sonora-border-strong);
		background: var(--sonora-surface-glass);
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
		box-shadow: 0 14px 36px rgba(0, 0, 0, 0.42);
		color: var(--sonora-text);
		cursor: pointer;
		text-align: left;
	}
	.symbol-chip:hover {
		border-color: var(--sonora-border-focus);
		background: var(--sonora-accent-soft);
	}
	.symbol-chip-glyph {
		display: flex;
		align-items: center;
		justify-content: center;
		width: var(--sonora-control-size);
		height: var(--sonora-control-size);
		overflow: hidden;
		border-radius: 10px;
		background: var(--sonora-bg-hover);
		font:
			22px/1 Leland,
			serif;
		color: var(--sonora-text);
		flex-shrink: 0;
	}
	.symbol-chip-meta {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.symbol-chip-meta strong {
		font-size: 12px;
		font-weight: 600;
		color: var(--sonora-text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.symbol-chip-meta span {
		font-size: 10px;
		color: var(--sonora-text-muted);
		white-space: nowrap;
	}

	/* Expanded symbol drawer — docked bottom-right, away from score center */
	.symbol-drawer {
		position: fixed;
		z-index: 46;
		left: 64px;
		bottom: 0;
		width: min(420px, calc(100vw - 24px));
		max-height: min(46vh, 400px);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 18px;
		background: var(--sonora-surface-glass);
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
		/* Empty chrome does not steal placement clicks */
		pointer-events: none;
	}
	.symbol-drawer > * {
		pointer-events: auto;
	}
	.symbol-drawer-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 12px 12px 8px;
	}
	.symbol-drawer-title {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.symbol-drawer-title strong {
		font-size: 14px;
		font-weight: 650;
	}
	.symbol-drawer-title span {
		font-size: 11px;
		color: var(--sonora-text-muted);
	}
	.symbol-drawer-actions {
		display: flex;
		align-items: center;
		gap: 2px;
	}
	.symbol-cats {
		display: flex;
		gap: 4px;
		padding: 0 12px 8px;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.symbol-cats::-webkit-scrollbar {
		display: none;
	}
	.symbol-cats button {
		flex-shrink: 0;
		height: 30px;
		padding: 0 12px;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--sonora-text-muted);
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
	}
	.symbol-cats button.active {
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
	}
	.symbol-search-row {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 0 12px 8px;
	}
	.symbol-search-row input:not([type]),
	.symbol-search-row > input {
		flex: 1;
		min-width: 0;
		height: 36px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 10px;
		background: var(--sonora-bg-deep);
		color: var(--sonora-text);
		padding: 0 12px;
		font-size: 13px;
		outline: none;
	}
	.symbol-size-control {
		display: flex;
		align-items: center;
		gap: 6px;
		color: var(--sonora-text-muted);
		font-size: 11px;
		white-space: nowrap;
	}
	.symbol-size-control input[type='range'] {
		width: 72px;
	}
	.symbol-tray {
		flex: 1;
		min-height: 110px;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(70px, 1fr));
		gap: 6px;
		padding: 4px 12px 12px;
		overflow: auto;
		align-content: start;
	}
	.symbol-tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: flex-start;
		gap: 6px;
		min-height: 68px;
		padding: 8px 4px 6px;
		border: 1px solid transparent;
		border-radius: 12px;
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
		cursor: pointer;
	}
	/* Fixed glyph viewport — tall SMuFL glyphs (G clef) no longer overflow */
	.symbol-tile .glyph-box {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 100%;
		height: 34px;
		overflow: hidden;
		line-height: 1;
	}
	.symbol-tile .glyph {
		display: block;
		font:
			26px/1 Leland,
			serif;
		/* Optical centering for glyphs with uneven bounding boxes */
		transform: translateY(1px);
	}
	.symbol-tile .name {
		font-size: 9px;
		color: var(--sonora-text-muted);
		text-align: center;
		line-height: 1.2;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.symbol-tile.selected,
	.symbol-tile:hover {
		border-color: var(--sonora-border-focus);
		background: var(--sonora-accent-soft);
	}
	.symbol-tile.selected .name,
	.symbol-tile:hover .name {
		color: var(--sonora-accent);
	}
	.symbol-empty {
		grid-column: 1 / -1;
		margin: 16px 0;
		text-align: center;
		color: var(--sonora-text-muted);
		font-size: 13px;
	}

	.text-editor-floating {
		position: fixed;
		z-index: 200;
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: min(280px, calc(100vw - 24px));
		max-width: calc(100vw - 24px);
		padding: 8px 10px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 14px;
		background: var(--sonora-surface-glass);
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
		pointer-events: auto;
	}
	.text-editor-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--sonora-text-muted);
		flex-shrink: 0;
	}
	.text-editor-floating input {
		flex: 1;
		min-width: 0;
		border: 0;
		outline: 0;
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
		padding: 8px 10px;
		font-size: 14px;
		border-radius: 8px;
	}
	.text-editor-floating button {
		width: 34px;
		height: 34px;
		border: 0;
		border-radius: 9px;
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
		display: grid;
		place-items: center;
		flex-shrink: 0;
	}
	.text-editor-floating button.text-editor-save {
		background: var(--sonora-success-soft);
		color: var(--sonora-success);
	}
	.text-editor-floating button:hover {
		background: var(--sonora-border-strong);
		color: var(--sonora-text);
	}
	.text-editor-floating button.text-editor-save:hover {
		background: var(--sonora-success-soft);
		color: var(--sonora-success);
	}
	.search-panel {
		position: absolute;
		z-index: 50;
		top: 56px;
		left: 50%;
		transform: translateX(-50%);
		width: min(620px, calc(100% - 24px));
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 8px 10px;
		background: var(--sonora-surface-glass);
		border: 1px solid var(--sonora-border-strong);
		border-top: 0;
		border-radius: 0 0 14px 14px;
		box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
	}
	.search-panel input {
		flex: 1;
		min-width: 0;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--sonora-text);
		font-size: 11px;
	}
	.search-panel span {
		color: var(--sonora-text-muted);
		font-size: 9px;
		white-space: nowrap;
	}
	.reading-exit {
		position: absolute;
		z-index: 70;
		top: 16px;
		right: 16px;
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 8px 11px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 10px;
		background: var(--sonora-surface-glass);
		color: var(--sonora-text);
		cursor: pointer;
		opacity: 0.55;
		transition: opacity 0.15s ease;
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
	}
	.reading-exit:hover {
		opacity: 1;
	}
	.reading .workspace {
		inset: 0;
	}
	.reading .page-hit {
		top: 0;
		bottom: 0;
	}
	.reading .pages {
		padding: 12px;
	}
	@keyframes settings-in {
		from {
			opacity: 0;
			transform: translateY(-5px) scale(0.98);
		}
		to {
			opacity: 1;
			transform: translateY(0) scale(1);
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (max-width: 900px), (max-height: 740px) {
		.palette {
			left: 8px;
			top: auto;
			bottom: 12px;
			transform: none;
			flex-direction: column-reverse;
			align-items: flex-start;
		}
		.palette.is-away {
			opacity: 0.12;
			transform: translateY(10px);
		}
		.tool-rail {
			max-width: calc(100vw - 48px);
			overflow-x: auto;
			flex-direction: row;
			padding: 6px 8px;
			border-radius: 16px;
		}
		.rail-group {
			flex-direction: row;
		}
		.rail-sep {
			width: 1px;
			height: 22px;
			margin: 0 3px;
		}
		.tool-options {
			flex-direction: row;
			max-width: none;
			align-items: center;
		}
		.opt-colors {
			flex-direction: row;
		}
		.opt-size {
			flex-direction: row;
		}
		.opt-size input[type='range'] {
			writing-mode: horizontal-tb;
			direction: ltr;
			width: 72px;
			height: 4px;
		}
		.symbol-chip {
			position: absolute;
			left: 0;
			top: auto;
			bottom: calc(100% + 8px); /* sit just above the bottom rail */
		}
		.symbol-drawer {
			left: 8px;
			right: 8px;
			width: auto;
			max-height: min(52vh, 380px);
		}
	}
	@media (max-width: 620px) {
		.score-title {
			display: none;
		}
		.topbar {
			padding: 8px;
		}
		.workspace {
			padding: 14px;
		}
		.symbol-drawer {
			max-height: 64vh;
		}
		.bottombar {
			padding: 7px;
		}
	}
	@media print {
		.topbar,
		.bottombar,
		.palette,
		.symbol-drawer,
		.search-panel,
		.loading,
		.error,
		.page-hit,
		.reading-exit {
			display: none !important;
		}
		.viewer {
			height: auto;
			overflow: visible;
			background: #fff;
		}
		.workspace {
			position: static;
			overflow: visible;
			padding: 0;
			background: #fff;
		}
		.pages {
			display: block;
		}
		.page-shell {
			box-shadow: none;
			page-break-after: always;
		}
	}
</style>
