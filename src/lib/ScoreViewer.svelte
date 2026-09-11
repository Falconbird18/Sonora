<script lang="ts">
	import { onMount, tick } from 'svelte';
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
	import SettingsPanel from './ui/SettingsPanel.svelte';
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
		Eye,
		EyeOff,
		Highlighter,
		Maximize2,
		Minimize2,
		Minus,
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

	type Tool =
		| 'pan'
		| 'pen'
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
		offscreen: HTMLCanvasElement;
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
	let reading = $state(false);
	let searchOpen = $state(false);
	let searchText = $state('');
	let searchStatus = $state('');
	let settingsOpen = $state(false);
	let bookmarked = $state(false);
	let annotationsVisible = $state(true);
	let isDrawing = $state(false);
	let tool = $state<Tool>('pan');
	let annotating = $derived(controls && tool !== 'pan' && !reading);
	const strokeTool = $derived(
		tool === 'pen' ||
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
	let histories = $state<Record<number, Snapshot[]>>({});
	let historyIndex = $state<Record<number, number>>({});
	let host = $state<HTMLElement | null>(null);
	let leftPdf = $state<HTMLCanvasElement | null>(null);
	let rightPdf = $state<HTMLCanvasElement | null>(null);
	let leftInk = $state<HTMLCanvasElement | null>(null);
	let rightInk = $state<HTMLCanvasElement | null>(null);
	let generation = 0;
	let tasks: PdfRenderTask[] = [];
	/** LRU cache of fully rendered page bitmaps keyed by `page@renderScale`. */
	const pageCache = new Map<string, PageBitmap>();
	const MAX_PAGE_CACHE = 20;
	function cacheKey(number: number, renderScale: number) {
		return `${number}@${Math.round(renderScale * 1000)}`;
	}
	function touchCache(key: string, bmp: PageBitmap) {
		if (pageCache.has(key)) pageCache.delete(key);
		pageCache.set(key, bmp);
		while (pageCache.size > MAX_PAGE_CACHE) {
			const oldest = pageCache.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			const old = pageCache.get(oldest);
			pageCache.delete(oldest);
			// Help GC release large canvases
			if (old?.offscreen) {
				old.offscreen.width = 0;
				old.offscreen.height = 0;
			}
		}
	}
	function clearPageCache() {
		for (const bmp of pageCache.values()) {
			if (bmp.offscreen) {
				bmp.offscreen.width = 0;
				bmp.offscreen.height = 0;
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
		visiblePages.some((p) => (historyIndex[p] ?? 0) > 0)
	);
	const canRedo = $derived(
		visiblePages.some(
			(p) => (historyIndex[p] ?? 0) < (histories[p]?.length ?? 1) - 1
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
