<script lang="ts">
	import { onMount, tick } from 'svelte';
	import { loadAnnotations, saveAnnotation, flushAnnotationSaves, requestPersistentStorage } from './annotationStore';
	import type { ScoreItem, Stroke, Point, SymbolStamp, TextNote } from './types';
	import { MUSIC_SYMBOLS, MUSIC_SYMBOL_CATEGORIES } from './musicSymbols';
	import { openPdfSource, closePdf, MAX_CANVAS_PIXELS } from './pdfUtils';
	import {
		acquireScreenWakeLock,
		releaseScreenWakeLock
	} from './wakeLock';
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

	type Tool = 'pan' | 'pen' | 'highlighter' | 'eraser' | 'line' | 'arrow' | 'symbol' | 'text';
	type Fit = 'page' | 'width';
	type Snapshot = { strokes: Stroke[]; stamps: SymbolStamp[]; notes: TextNote[] };
	type TextEditor = { page: number; x: number; y: number; text: string; id?: string; screenX?: number; screenY?: number };

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
	let tool = $state<Tool>('pan');
	let annotating = $derived(controls && tool !== 'pan' && !reading);
	let color = $state('#111827');
	let width = $state(3);
	let selectedSymbol = $state(MUSIC_SYMBOLS[0]);
	let symbolCategory = $state<'Recent' | (typeof MUSIC_SYMBOL_CATEGORIES)[number]>('Recent');
	let symbolSearch = $state('');
	let symbolSize = $state(34);
	let recentSymbols = $state<string[]>([]);
	let cursorScreen = $state<{ x: number; y: number } | null>(null);
	let loupeCanvas = $state<HTMLCanvasElement | null>(null);
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
	let textSize = $state(18);
	let textEditor = $state<TextEditor | null>(null);
	let textDraft = $state('');
	let draggingAnnot: { kind: 'stamp' | 'note'; page: number; id: string; canvas: HTMLCanvasElement; pointerId: number } | null = null;
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
	const colors = ['#c2410c', '#111827', '#2563eb', '#15803d', '#a16207', '#7e22ce', '#ffffff'];
	const primaryColors = colors.slice(0, 3);
	const extraColors = colors.slice(3);
	let colorPickerOpen = $state(false);
	const visiblePages = $derived(
		pdf ? (dual ? [page, Math.min(pdf.numPages, page + 1)] : [page]) : [page]
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
			return recentSymbolObjects.length ? recentSymbolObjects : MUSIC_SYMBOLS.slice(0, 24);
		}
		return MUSIC_SYMBOLS.filter((s) => s.category === symbolCategory);
	});
	const canUndo = $derived((historyIndex[page] ?? 0) > 0);
	const canRedo = $derived((historyIndex[page] ?? 0) < (histories[page]?.length ?? 1) - 1);


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

	onMount(() => {
		try {
			const saved = JSON.parse(localStorage.getItem(prefs) || '{}');
			bookmarked = !!saved.bookmarked;
			autoLayout = saved.autoLayout !== false;
			keepAwake = saved.keepAwake !== false;
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
		void requestWakeLock();
		const onVisibility = () => {
			if (document.visibilityState === 'visible') void requestWakeLock();
			else void releaseWakeLock();
		};
		document.addEventListener('visibilitychange', onVisibility);
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
			} else if (event.key === '+' || event.key === '=') setZoom(zoom + 0.08);
			else if (event.key === '-') setZoom(zoom - 0.08);
			else if (event.key.toLowerCase() === 'f') {
				event.preventDefault();
				reading ? exitReading() : enterReading();
			} else if (event.key.toLowerCase() === 'p') { controls = true; choose('pen'); }
			else if (event.key.toLowerCase() === 'h') { controls = true; choose('highlighter'); }
			else if (event.key.toLowerCase() === 'e') { controls = true; choose('eraser'); }
			else if (event.key.toLowerCase() === 's') { controls = true; choose('symbol'); }
			else if (event.key.toLowerCase() === 't') { controls = true; choose('text'); }
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
			resizeTimer = setTimeout(() => void render({ quiet: true }), 100);
		});
		if (host) observer.observe(host);
		const onPageHide = () => {
			void flushPendingAnnotations();
		};
		window.addEventListener('pagehide', onPageHide);
		return () => {
			window.removeEventListener('keydown', key);
			document.removeEventListener('fullscreenchange', onFullscreen);
			document.removeEventListener('visibilitychange', onVisibility);
			window.removeEventListener('pagehide', onPageHide);
			observer.disconnect();
			clearTimeout(resizeTimer);
			clearTimeout(prefetchTimer);
			clearTimeout(zoomTimer);
			stopPanMomentum();
			cancelRender();
			void releaseWakeLock();
			// Flush annotations before marking closed / tearing down canvases.
			void flushPendingAnnotations().finally(() => {
				closed = true;
				releaseCanvases();
				if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
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
		if (nextTool !== 'text') {
			textEditor = null;
			textDraft = '';
		}
		if (nextTool !== 'eraser' && nextTool !== 'symbol') cursorScreen = null;
		if (nextTool === 'symbol' && symbolCategory !== 'Recent' && !symbolSearch.trim()) {
			// keep current category
		}
	}

	function hitAnnotation(number: number, point: Point, radius = 0.04): { kind: 'stamp' | 'note'; id: string } | null {
		for (let i = (stamps[number] || []).length - 1; i >= 0; i--) {
			const stamp = stamps[number][i];
			if (Math.hypot(stamp.x - point.x, stamp.y - point.y) <= radius) return { kind: 'stamp', id: stamp.id };
		}
		for (let i = (notes[number] || []).length - 1; i >= 0; i--) {
			const note = notes[number][i];
			if (Math.hypot(note.x - point.x, note.y - point.y) <= radius) return { kind: 'note', id: note.id };
		}
		return null;
	}

	function placeSymbolAt(number: number, point: Point, canvas: HTMLCanvasElement | null) {
		const stamp = {
			id: crypto.randomUUID(),
			symbol: selectedSymbol.glyph,
			label: selectedSymbol.name,
			x: point.x,
			y: point.y,
			fontSize: symbolSize,
			color
		};
		stamps[number] = [...(stamps[number] || []), stamp];
		recentSymbols = [selectedSymbol.id, ...recentSymbols.filter((id) => id !== selectedSymbol.id)].slice(0, 10);
		persistPrefs();
		if (canvas) redraw(number, canvas);
		checkpoint(number);
	}

	function placeSymbolOnPage() {
		const canvas = leftInk ?? rightInk;
		placeSymbolAt(page, { x: 0.5, y: 0.4 }, canvas);
	}

	function begin(event: PointerEvent, number: number, canvas: HTMLCanvasElement) {
		if (reading || !annotating) return;
		if (textEditor) {
			commitText();
			return;
		}
		event.preventDefault();
		const point = position(event, canvas);
		if (tool !== 'eraser') {
			const hit = hitAnnotation(number, point, tool === 'symbol' || tool === 'text' ? 0.05 : 0.035);
			if (hit) {
				canvas.setPointerCapture(event.pointerId);
				draggingAnnot = { kind: hit.kind, page: number, id: hit.id, canvas, pointerId: event.pointerId };
				return;
			}
		}
		canvas.setPointerCapture(event.pointerId);
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
			erase(point, number, canvas, false);
			return;
		}
		const stroke: Stroke = {
			id: crypto.randomUUID(),
			tool: tool === 'highlighter' ? 'highlighter' : 'pen',
			kind: tool === 'line' ? 'line' : tool === 'arrow' ? 'arrow' : 'freehand',
			color,
			width,
			points: [point]
		};
		ensureHistory(number);
		strokes[number] = [...(strokes[number] || []), stroke];
		drawing = { page: number, canvas, pointerId: event.pointerId, stroke };
		redraw(number, canvas);
	}

	function openTextEditor(number: number, point: Point) {
		const existing = (notes[number] || []).find(
			(note) => Math.hypot(note.x - point.x, note.y - point.y) < 0.04
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
		textEditor = { page: number, x, y, text: textDraft, id: existing?.id, screenX, screenY };
		void tick().then(() => {
			const el = document.querySelector<HTMLInputElement>('[data-score-text-input]');
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
					note.id === editor.id ? { ...note, text, fontSize: textSize, color } : note
				);
			else
				notes[editor.page] = [
					...(notes[editor.page] || []),
					{ id: crypto.randomUUID(), text, x: editor.x, y: editor.y, fontSize: textSize, color }
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

	function updateCursorOverlay(event: PointerEvent, canvas?: HTMLCanvasElement | null) {
		if (tool !== 'eraser' && tool !== 'symbol') {
			cursorScreen = null;
			return;
		}
		cursorScreen = { x: event.clientX, y: event.clientY };
		if (tool === 'symbol' && canvas) {
			requestAnimationFrame(() => paintLoupe(event, canvas));
		}
	}

	function paintLoupe(event: PointerEvent, sourceCanvas: HTMLCanvasElement) {
		const loupe = loupeCanvas;
		if (!loupe || !cursorScreen) return;
		const ctx = loupe.getContext('2d');
		if (!ctx) return;
		const size = 120;
		if (loupe.width !== size) {
			loupe.width = size;
			loupe.height = size;
		}
		const rect = sourceCanvas.getBoundingClientRect();
		const sx = ((event.clientX - rect.left) / rect.width) * sourceCanvas.width;
		const sy = ((event.clientY - rect.top) / rect.height) * sourceCanvas.height;
		const srcR = 28 * (sourceCanvas.width / Math.max(1, rect.width));
		ctx.clearRect(0, 0, size, size);
		ctx.save();
		ctx.beginPath();
		ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
		ctx.clip();
		// Prefer PDF underlay if available
		const pdfUnder =
			sourceCanvas === leftInk ? leftPdf : sourceCanvas === rightInk ? rightPdf : null;
		const under = pdfUnder && pdfUnder.width ? pdfUnder : sourceCanvas;
		try {
			ctx.drawImage(
				under,
				sx - srcR,
				sy - srcR,
				srcR * 2,
				srcR * 2,
				0,
				0,
				size,
				size
			);
		} catch {
			/* cross-origin / empty */
		}
		// Overlay ink layer when under is PDF
		if (under !== sourceCanvas && sourceCanvas.width) {
			try {
				ctx.drawImage(
					sourceCanvas,
					sx - srcR,
					sy - srcR,
					srcR * 2,
					srcR * 2,
					0,
					0,
					size,
					size
				);
			} catch {}
		}
		// Placement crosshair + symbol preview
		ctx.strokeStyle = 'rgba(255,255,255,1)';
		ctx.lineWidth = 1.25;
		ctx.beginPath();
		ctx.moveTo(size / 2 - 10, size / 2);
		ctx.lineTo(size / 2 + 10, size / 2);
		ctx.moveTo(size / 2, size / 2 - 10);
		ctx.lineTo(size / 2, size / 2 + 10);
		ctx.stroke();
		ctx.font = `${Math.round(symbolSize * 1.35)}px Leland, serif`;
		ctx.textAlign = 'center';
		ctx.textBaseline = 'middle';
		ctx.fillStyle = color;
		ctx.globalAlpha = 0.92;
		ctx.fillText(selectedSymbol.glyph, size / 2, size / 2);
		ctx.restore();
		// Outer ring
		ctx.beginPath();
		ctx.arc(size / 2, size / 2, size / 2 - 0.75, 0, Math.PI * 2);
		ctx.strokeStyle = 'rgba(255,255,255,1)';
		ctx.lineWidth = 2;
		ctx.stroke();
	}

	function move(event: PointerEvent) {
		const targetCanvas =
			draggingAnnot?.canvas ||
			drawing?.canvas ||
			(event.currentTarget instanceof HTMLCanvasElement ? event.currentTarget : null);
		updateCursorOverlay(event, targetCanvas);

		if (draggingAnnot) {
			const point = position(event, draggingAnnot.canvas);
			const x = Math.min(0.98, Math.max(0.02, point.x));
			const y = Math.min(0.98, Math.max(0.02, point.y));
			if (draggingAnnot.kind === 'stamp') {
				stamps[draggingAnnot.page] = (stamps[draggingAnnot.page] || []).map((stamp) =>
					stamp.id === draggingAnnot!.id ? { ...stamp, x, y } : stamp
				);
			} else {
				notes[draggingAnnot.page] = (notes[draggingAnnot.page] || []).map((note) =>
					note.id === draggingAnnot!.id ? { ...note, x, y } : note
				);
			}
			redraw(draggingAnnot.page, draggingAnnot.canvas);
			return;
		}
		if (!drawing) return;
		for (const pointEvent of event.getCoalescedEvents?.() || [event]) {
			if (drawing.stroke) {
				const stroke = (strokes[drawing.page] || []).find((item) => item.id === drawing?.stroke?.id);
				if (stroke) {
					const point = position(pointEvent, drawing.canvas);
					stroke.points =
						stroke.kind === 'line' || stroke.kind === 'arrow'
							? [stroke.points[0], point]
							: [...stroke.points, point];
				}
			} else erase(position(pointEvent, drawing.canvas), drawing.page, drawing.canvas, false);
		}
		if (!drawing.raf)
			drawing.raf = requestAnimationFrame(() => {
				if (drawing) redraw(drawing.page, drawing.canvas);
				if (drawing) drawing.raf = undefined;
			});
	}
	function end() {
		if (draggingAnnot) {
			const active = draggingAnnot;
			draggingAnnot = null;
			try { active.canvas.releasePointerCapture(active.pointerId); } catch {}
			checkpoint(active.page);
			redraw(active.page, active.canvas);
			return;
		}
		if (!drawing) return;
		const active = drawing;
		if (active.raf) cancelAnimationFrame(active.raf);
		drawing = null;
		try { active.canvas.releasePointerCapture(active.pointerId); } catch {}
		redraw(active.page, active.canvas);
		checkpoint(active.page);
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

	function strokeHitsEraser(stroke: Stroke, point: Point, radius: number): boolean {
		const pts = stroke.points;
		if (!pts.length) return false;
		// Point hits (works for freehand samples and endpoints)
		for (const candidate of pts) {
			if (Math.hypot(candidate.x - point.x, candidate.y - point.y) < radius) return true;
		}
		// Segment hits — critical for line / arrow (often only 2 points)
		for (let i = 1; i < pts.length; i++) {
			if (distPointToSegment(point, pts[i - 1], pts[i]) < radius) return true;
		}
		return false;
	}

	function erase(point: Point, number: number, canvas: HTMLCanvasElement | null, save = true) {
		const radius = Math.max(0.012, width / 700);
		let changed = false;
		const before = strokes[number] || [];
		const after = before.filter((stroke) => !strokeHitsEraser(stroke, point, radius));
		if (after.length !== before.length) {
			strokes[number] = after;
			changed = true;
		}
		const nextStamps = (stamps[number] || []).filter(
			(stamp) => Math.hypot(stamp.x - point.x, stamp.y - point.y) > radius * 1.6
		);
		if (nextStamps.length !== (stamps[number] || []).length) {
			stamps[number] = nextStamps;
			changed = true;
		}
		const nextNotes = (notes[number] || []).filter(
			(note) => Math.hypot(note.x - point.x, note.y - point.y) > radius * 1.8
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
		const rect = canvas.getBoundingClientRect();
		const scale = canvas.width / Math.max(1, rect.width);
		context.setTransform(scale, 0, 0, scale, 0, 0);
		context.clearRect(0, 0, rect.width, rect.height);
		if (!annotationsVisible) return;
		for (const stroke of strokes[number] || []) drawStroke(context, stroke, canvas);
		context.save();
		context.textAlign = 'center';
		context.textBaseline = 'middle';
		for (const stamp of stamps[number] || []) {
			const p = pointToCanvas({ x: stamp.x, y: stamp.y }, canvas);
			context.font = `${stamp.fontSize}px Leland, serif`;
			context.fillStyle = stamp.color;
			context.fillText(stamp.symbol, p.x, p.y);
		}
		context.restore();
		for (const note of notes[number] || []) {
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
	function drawStroke(context: CanvasRenderingContext2D, stroke: Stroke, canvas: HTMLCanvasElement) {
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
			for (let i = 1; i < points.length; i++) context.lineTo(points[i].x, points[i].y);
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
		if (!histories[number]) {
			histories[number] = [snapshot(number)];
			historyIndex[number] = 0;
		}
	}
	function checkpoint(number: number) {
		ensureHistory(number);
		const list = histories[number];
		const index = historyIndex[number] ?? list.length - 1;
		const nextList = [...list.slice(0, index + 1), snapshot(number)].slice(-80);
		histories[number] = nextList;
		historyIndex[number] = nextList.length - 1;
		scheduleSave(number);
	}
	function applySnapshot(number: number, state: Snapshot) {
		strokes[number] = cloneData(state.strokes);
		stamps[number] = cloneData(state.stamps);
		notes[number] = cloneData(state.notes);
		redraw(number, number === visiblePages[0] ? leftInk : rightInk);
		scheduleSave(number);
	}
	function undo() {
		ensureHistory(page);
		const index = historyIndex[page] ?? 0;
		if (index > 0) {
			historyIndex[page] = index - 1;
			applySnapshot(page, histories[page][index - 1]);
		}
	}
	function redo() {
		ensureHistory(page);
		const index = historyIndex[page] ?? 0;
		if (index < histories[page].length - 1) {
			historyIndex[page] = index + 1;
			applySnapshot(page, histories[page][index + 1]);
		}
	}
	function scheduleSave(number: number) {
		const old = saveTimers.get(number);
		if (old) clearTimeout(old);
		saveTimers.set(number, setTimeout(() => {
			saveTimers.delete(number);
			void saveAnnotations(number).catch((error) => console.error('Annotation save failed', error));
		}, 150));
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
			JSON.stringify({ bookmarked, dual, autoLayout, keepAwake, zoom, fit, annotationsVisible, recentSymbols, page })
		);
	}
	function setZoom(value: number) {
		const next = Math.max(0.35, Math.min(3, Number(value.toFixed(3))));
		if (Math.abs(next - zoom) < 0.001) return;
		zoom = next;
		persistPrefs();
		clearTimeout(zoomTimer);
		// Short debounce keeps wheel zoom fluid while avoiding per-frame PDF re-renders
		zoomTimer = setTimeout(() => void render({ quiet: hasPainted }), 48);
	}
	function setFit(value: Fit) {
		fit = value;
		zoom = 1;
		resetPan();
		persistPrefs();
		void render({ quiet: hasPainted });
	}
	function next() {
		if (!pdf) return;
		pageTransition = true;
		resetPan();
		page = Math.min(pdf.numPages, dual ? Math.min(pdf.numPages, page + 2) : page + 1);
		pageInput = String(page);
		ensureHistory(page);
		persistPrefs();
		void render({ quiet: hasPainted }).finally(() => {
			requestAnimationFrame(() => { pageTransition = false; });
		});
	}
	function previous() {
		pageTransition = true;
		resetPan();
		page = Math.max(1, dual ? page - 2 : page - 1);
		pageInput = String(page);
		ensureHistory(page);
		persistPrefs();
		void render({ quiet: hasPainted }).finally(() => {
			requestAnimationFrame(() => { pageTransition = false; });
		});
	}
	function goToPage() {
		const value = Math.max(1, Math.min(pdf?.numPages || 1, Number.parseInt(pageInput, 10) || 1));
		page = dual && value % 2 === 0 ? value - 1 : value;
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

	function onWorkspacePointerDown(event: PointerEvent) {
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
			(event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
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
			const step =
				event.deltaMode === 0
					? Math.min(0.18, Math.max(0.02, Math.abs(event.deltaY) * 0.0018))
					: 0.08;
			setZoom(zoom + (event.deltaY > 0 ? -step : step));
			return;
		}
		// Trackpad / mouse wheel pans the view (buttery, no layout thrash)
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
		const href = score.pdfUrl || (score.pdfBlob ? URL.createObjectURL(score.pdfBlob) : '');
		if (!href) return;
		const link = document.createElement('a');
		link.href = href;
		link.download = `${score.title}.pdf`;
		link.target = '_blank';
		link.rel = 'noopener';
		link.click();
		if (score.pdfBlob && !score.pdfUrl) setTimeout(() => URL.revokeObjectURL(href), 1000);
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
				<button class="icon-button" title="Back to library" aria-label="Back to library" onclick={() => void leave()}
					><ArrowLeft size={19} /></button>
				<div class="score-title">
					<strong>{score.title}</strong><span>{score.composer}</span>
				</div>
			</div>
			<div class="page-controls">
				<button class="icon-button" title="Previous page" aria-label="Previous page" onclick={previous} disabled={page <= 1}
					><ChevronLeft size={19} /></button>
				<input aria-label="Page number" bind:value={pageInput} onkeydown={(e) => e.key === 'Enter' && goToPage()} onblur={goToPage} />
				<span>/ {pdf?.numPages ?? score.totalPages}</span>
				<button class="icon-button" title="Next page" aria-label="Next page" onclick={next} disabled={!pdf || page >= pdf.numPages}
					><ChevronRight size={19} /></button>
			</div>
			<div class="topbar-right">
				<button class="icon-button" class:active={bookmarked} title={bookmarked ? 'Remove bookmark' : 'Bookmark score'} onclick={toggleBookmark}
					>{#if bookmarked}<BookmarkCheck size={18} />{:else}<Bookmark size={18} />{/if}</button>
				<button class="icon-button" title="Search score" onclick={() => (searchOpen = !searchOpen)}><Search size={18} /></button>
				<button class="icon-button" title="Reading mode (F)" onclick={enterReading}><Eye size={18} /></button>
			</div>
		</header>
	{:else}
		<button class="reading-exit" title="Exit reading mode" aria-label="Exit reading mode" onclick={exitReading}
			><Minimize2 size={17} /><span>Exit reading</span></button>
	{/if}

	{#if !reading}
		<footer class="bottombar">
			<div class="footer-section">
				<button class="icon-button" class:active={fit === 'page'} title="Fit page" onclick={() => setFit('page')}><Scan size={16} /></button>
				<button class="icon-button" class:active={fit === 'width'} title="Fit width" onclick={() => setFit('width')}><StretchHorizontal size={17} /></button>
				<button class="icon-button" title="Zoom out" onclick={() => setZoom(zoom - 0.08)}><ZoomOut size={17} /></button>
				<span>{Math.round(zoom * 100)}%</span>
				<button class="icon-button" title="Zoom in" onclick={() => setZoom(zoom + 0.08)}><ZoomIn size={17} /></button>
			</div>
			<div class="footer-section">
				<button
					class:active={dual}
					class="text-button"
					onclick={() => {
						autoLayout = false;
						dual = !dual;
						persistPrefs();
						void render({ quiet: hasPainted });
					}}><Columns2 size={15} />{dual ? 'Single page' : 'Two pages'}</button>
				<button class="icon-button" title="Show/hide annotations" onclick={toggleAnnotations}
					>{#if annotationsVisible}<Eye size={17} />{:else}<EyeOff size={17} />{/if}</button>
				<button class="icon-button" title="Fullscreen" onclick={toggleFullScreen}
					>{#if isFullscreen}<Minimize2 size={17} />{:else}<Maximize2 size={17} />{/if}</button>
				<button class="icon-button" title="Settings" onclick={() => (settingsOpen = !settingsOpen)}><Settings2 size={17} /></button>
			</div>
		</footer>
	{/if}


	{#if searchOpen && !reading}<div class="search-panel">
			<Search size={17} /><input bind:value={searchText} placeholder="Find text in this score…" onkeydown={(e) => e.key === 'Enter' && searchPdf()} />
			<button class="text-button" onclick={searchPdf}>Find</button>
			<span>{searchStatus}</span>
			<button class="icon-button" aria-label="Close search" onclick={() => (searchOpen = false)}><X size={17} /></button>
		</div>{/if}

	<main
		class="workspace"
		class:fit-page={fit === 'page'}
		class:is-panning={!!panDrag}
		class:is-annotating={annotating}
		onwheel={onWheel}
		onpointerdown={onWorkspacePointerDown}
		onpointermove={onWorkspacePointerMove}
		onpointerup={onWorkspacePointerUp}
		onpointercancel={onWorkspacePointerUp}
	>
		<div
			class="pages"
			class:dual
			class:transitioning={pageTransition}
			style={`transform: translate3d(${panX}px, ${panY}px, 0)`}
		>
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

	<button class="page-hit left-hit" aria-label="Previous page" onclick={previous} disabled={page <= 1 || !!textEditor }></button>
	<button class="page-hit right-hit" aria-label="Next page" onclick={next} disabled={!pdf || page >= (pdf?.numPages ?? 1) || !!textEditor }></button>


	{#if textEditor}
		<div
			class="text-editor-floating"
			style={`left:${textEditor.screenX ?? 24}px;top:${textEditor.screenY ?? 120}px`}
			onpointerdown={(e) => e.stopPropagation()}
		>
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
				}}
			/>
			<button type="button" class="text-editor-save" title="Save" onclick={commitText}><Check size={15} /></button>
			<button type="button" title="Cancel" onclick={cancelText}><X size={15} /></button>
		</div>
	{/if}

	{#if !reading && !controls}
		<button class="annotation-toggle" title="Annotation tools" aria-label="Open annotation tools" onclick={toggleControls}><Pencil size={18} /></button>
	{/if}
	{#if !reading && controls}
		<aside class="annotation-bar">
			<div class="tool-group">
				<button class:active={tool === 'pen'} class="tool-button" data-tool="pen" title="Pen (P)" onclick={() => choose('pen')}><PenTool size={18} /><span>Pen</span></button>
				<button class:active={tool === 'highlighter'} class="tool-button" data-tool="highlighter" title="Highlighter (H)" onclick={() => choose('highlighter')}><Highlighter size={18} /><span>Highlight</span></button>
				<button class:active={tool === 'line'} class="tool-button" data-tool="line" title="Line" onclick={() => choose('line')}><Minus size={18} /><span>Line</span></button>
				<button class:active={tool === 'arrow'} class="tool-button" data-tool="arrow" title="Arrow" onclick={() => choose('arrow')}><ArrowUpRight size={18} /><span>Arrow</span></button>
				<button class:active={tool === 'eraser'} class="tool-button" data-tool="eraser" title="Eraser (E)" onclick={() => choose('eraser')}><Eraser size={18} /><span>Erase</span></button>
				<button class:active={tool === 'symbol'} class="tool-button" data-tool="symbol" title="Symbols (S)" onclick={() => choose('symbol')}><Music2 size={18} /><span>Symbols</span></button>
				<button class:active={tool === 'text'} class="tool-button" data-tool="text" title="Text (T)" onclick={() => choose('text')}><Type size={18} /><span>Text</span></button>
			</div>
			<div class="divider"></div>
			<div class="tool-group compact">
				<button class="icon-button" title="Undo" disabled={!canUndo} onclick={undo}><Undo2 size={18} /></button>
				<button class="icon-button" title="Redo" disabled={!canRedo} onclick={redo}><Redo2 size={18} /></button>
				<div class="color-row">
					{#each primaryColors as swatch}
						<button class="swatch" class:selected={color === swatch} style={`--swatch:${swatch}`} title={swatch} onclick={() => { color = swatch; colorPickerOpen = false; }}></button>
					{/each}
					<div class="color-more-wrap">
						<button
							class="swatch more-swatch"
							class:selected={extraColors.includes(color)}
							class:open={colorPickerOpen}
							style={extraColors.includes(color) ? `--swatch:${color}` : ''}
							title="More colors"
							aria-label="More colors"
							aria-expanded={colorPickerOpen}
							onclick={() => (colorPickerOpen = !colorPickerOpen)}
						>
							{#if !extraColors.includes(color)}
								<span class="more-plus">+</span>
							{/if}
						</button>
						{#if colorPickerOpen}
							<div class="color-popup" role="listbox" aria-label="More colors">
								{#each extraColors as swatch}
									<button
										class="swatch"
										class:selected={color === swatch}
										style={`--swatch:${swatch}`}
										title={swatch}
										role="option"
										aria-selected={color === swatch}
										onclick={() => { color = swatch; colorPickerOpen = false; }}
									></button>
								{/each}
							</div>
						{/if}
					</div>
				</div>
				<label class="range-label size-slider">
					<span>Size</span>
					<input type="range" min="1" max="14" bind:value={width} />
					<span class="size-value">{width}</span>
				</label>
				<button class="icon-button" title="Close annotation tools" onclick={toggleControls}><X size={18} /></button>
			</div>
		</aside>
	{/if}

	{#if !reading && controls && tool === 'symbol'}
		<div class="symbol-sheet" role="dialog" aria-label="Musical symbols">
			<header class="symbol-sheet-head">
				<div class="symbol-sheet-title">
					<strong>Symbols</strong>
					<span>Click page to place · drag to move</span>
				</div>
				<button type="button" class="icon-button" title="Close symbols" aria-label="Close symbols" onclick={() => choose('pan')}><X size={17} /></button>
			</header>

			<div class="symbol-search-row">
				<input bind:value={symbolSearch} placeholder="Search symbols…" aria-label="Search symbols" />
				<label class="symbol-size-control" title="Size">
					<span>{symbolSize}px</span>
					<input type="range" min="20" max="64" bind:value={symbolSize} />
				</label>
			</div>

			<nav class="symbol-cats" aria-label="Symbol tags">
				<button
					type="button"
					class:active={symbolCategory === 'Recent' && !symbolSearch.trim()}
					onclick={() => {
						symbolCategory = 'Recent';
						symbolSearch = '';
					}}
				>Recent</button>
				{#each MUSIC_SYMBOL_CATEGORIES as category}
					<button
						type="button"
						class:active={symbolCategory === category && !symbolSearch.trim()}
						onclick={() => {
							symbolCategory = category;
							symbolSearch = '';
						}}
					>{category}</button>
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
						}}
					>
						<span class="glyph">{symbol.glyph}</span>
						<span class="name">{symbol.name}</span>
					</button>
				{:else}
					<p class="symbol-empty">{symbolSearch.trim() ? `No symbols match “${symbolSearch}”` : 'No recent symbols yet — pick one below'}</p>
				{/each}
			</div>
		</div>
	{/if}


	{#if cursorScreen && tool === 'eraser' && !reading}
		<div
			class="eraser-cursor"
			style={`left:${cursorScreen.x}px;top:${cursorScreen.y}px;--eraser-size:${Math.max(14, width * 1.8)}px`}
			aria-hidden="true"
		></div>
	{/if}
	{#if cursorScreen && tool === 'symbol' && !reading}
		<div
			class="symbol-loupe"
			style={`left:${cursorScreen.x}px;top:${cursorScreen.y}px`}
			aria-hidden="true"
		>
			<canvas bind:this={loupeCanvas} width="120" height="120"></canvas>
		</div>
	{/if}

	{#if settingsOpen && !reading}
		<div class="settings-backdrop" role="presentation" onclick={() => { settingsOpen = false; persistPrefs(); }}></div>
		<div class="settings-card" role="dialog" aria-label="Viewer settings">
			<header class="settings-header">
				<strong>Viewer settings</strong>
				<button class="icon-button" title="Close settings" onclick={() => { settingsOpen = false; persistPrefs(); }}><X size={17} /></button>
			</header>

			<section class="settings-section">
				<h3>File</h3>
				<div class="settings-actions">
					<button class="text-button" onclick={printScore}><Printer size={15} />Print</button>
					<button class="text-button" onclick={downloadScore}><Download size={15} />Download PDF</button>
				</div>
			</section>

			<section class="settings-section">
				<h3>Layout</h3>
				<label class="settings-row">
					<span>
						<span class="label-title">Auto layout</span>
						<span class="label-desc">Two pages in landscape, one page in portrait</span>
					</span>
					<input
						type="checkbox"
						bind:checked={autoLayout}
						onchange={() => {
							if (autoLayout) {
								const landscape = window.matchMedia('(orientation: landscape)').matches;
								dual = landscape && (host?.clientWidth ?? window.innerWidth) >= 720;
							}
							persistPrefs();
							void render({ quiet: hasPainted });
						}}
					/>
				</label>
				<label class="settings-row" class:disabled={autoLayout}>
					<span>
						<span class="label-title">Two-page view</span>
						<span class="label-desc">{autoLayout ? 'Controlled by orientation' : 'Show two pages side by side'}</span>
					</span>
					<input
						type="checkbox"
						bind:checked={dual}
						disabled={autoLayout}
						onchange={() => {
							persistPrefs();
							void render({ quiet: hasPainted });
						}}
					/>
				</label>
				<label class="settings-row">
					<span>
						<span class="label-title">Keep screen on</span>
						<span class="label-desc">{wakeLockActive ? 'Screen will stay awake while viewing' : 'Prevents the display from sleeping while a score is open'}</span>
					</span>
					<input
						type="checkbox"
						bind:checked={keepAwake}
						onchange={() => {
							persistPrefs();
							if (keepAwake) void requestWakeLock();
							else void releaseWakeLock();
						}}
					/>
				</label>
			</section>

			<section class="settings-section">
				<h3>Annotations</h3>
				<label class="settings-row">
					<span>
						<span class="label-title">Show annotations</span>
						<span class="label-desc">Pens, highlights, symbols, and text</span>
					</span>
					<input type="checkbox" bind:checked={annotationsVisible} onchange={toggleAnnotations} />
				</label>
				<label class="settings-row">
					<span class="label-title">Text size</span>
					<input type="range" min="10" max="36" bind:value={textSize} />
					<span class="range-value">{textSize}px</span>
				</label>
			</section>

			<section class="settings-section">
				<h3>Shortcuts</h3>
				<ul class="shortcut-list">
					<li><kbd>F</kbd> Reading mode</li>
					<li><kbd>←</kbd> <kbd>→</kbd> / <kbd>Space</kbd> Page turn</li>
					<li><kbd>Ctrl</kbd> + scroll Zoom</li>
					<li><kbd>Esc</kbd> Back / close</li>
					<li><kbd>P</kbd> Pen · <kbd>H</kbd> Highlight · <kbd>E</kbd> Eraser</li>
				</ul>
			</section>

			<footer class="settings-footer">
				<button class="text-button primary" onclick={() => { settingsOpen = false; persistPrefs(); }}>Done</button>
			</footer>
		</div>
	{/if}
</div>

<style>
	@font-face {
		font-family: Leland;
		src: url('/fonts/Leland.otf') format('opentype'), url('/Leland.otf') format('opentype');
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
		font-family: var(--sonora-font, Inter, ui-sans-serif, system-ui, sans-serif);
	}
	.topbar {
		position: relative;
		z-index: 30;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		padding: 9px 14px;
		background: rgba(25, 25, 22, 0.96);
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
		backdrop-filter: blur(18px);
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

	.footer-section {
    	display: flex;
        align-items: center;
        gap: 5px;
    	z-index: 30;
    	min-height: 44px;
    	padding: 5px;
    	border: 1px solid rgba(255, 255, 255, 0.08);
    	border-radius: 14px;
    	background: rgba(25, 25, 22, 0.78);
    	backdrop-filter: blur(18px);
	}

	.topbar-left,
	.topbar-right,
	.page-controls,
	.footer-section,
	.tool-group,
	.color-row {
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
		color: #85857d;
		font-size: 10px;
		margin-top: 2px;
	}
	.page-controls {
		justify-content: center;
	}
	.icon-button,
	.tool-button,
	.text-button {
		border: 1px solid transparent;
		background: transparent;
		color: #aaa9a1;
		border-radius: 9px;
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
	}
	.icon-button {
		width: 36px;
		height: 36px;
	}
	.icon-button:hover,
	.tool-button:hover,
	.text-button:hover,
	.icon-button.active {
		background: rgba(255, 255, 255, 0.08);
		color: #fff;
	}
	.tool-button.active {
		color: #fff;
		background: color-mix(in srgb, var(--tool-accent, #3b82f6) 28%, transparent);
		box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--tool-accent, #3b82f6) 55%, transparent);
	}
	.tool-button[data-tool='pen'] { --tool-accent: #f59e0b; }
	.tool-button[data-tool='highlighter'] { --tool-accent: #eab308; }
	.tool-button[data-tool='line'] { --tool-accent: #38bdf8; }
	.tool-button[data-tool='arrow'] { --tool-accent: #22d3ee; }
	.tool-button[data-tool='eraser'] { --tool-accent: #f87171; }
	.tool-button[data-tool='symbol'] { --tool-accent: #a78bfa; }
	.tool-button[data-tool='text'] { --tool-accent: #4ade80; }
	.icon-button:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}
	.text-button {
		min-height: 36px;
		padding: 7px 10px;
		gap: 5px;
		font-size: 11px;
		animation: settings-in 160ms cubic-bezier(.2,.8,.2,1);
	}
	.page-controls input {
		width: 48px;
		height: 34px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 9px;
		background: #0d0d0b;
		color: #fff;
		text-align: center;
		outline: none;
	}
	.page-controls span {
		color: #77776f;
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
		background: var(--sonora-bg-workspace, radial-gradient(circle at 50% 18%, #292923 0, #151512 48%, #0f0f0d 100%));
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
	.workspace::-webkit-scrollbar { display: none; }

	.pages {
		display: flex;
		align-items: flex-start;
		justify-content: center;
		gap: 20px;
		min-width: max-content;
		margin: auto;
		will-change: transform;
		transform: translate3d(0, 0, 0);
		/* no transition while dragging — applied only when we want settle */
	}
	.pages.dual {
		gap: 0;
	}
	.pages.transitioning .page-shell {
		opacity: 0.55;
		transition: opacity 120ms ease;
	}
	.pages.dual .page-shell { box-shadow: 0 18px 55px rgba(0,0,0,.42); }
	/* Realistic inner-page gutter gradients (book-like) */
	.pages.dual .page-shell::after {
		content: '';
		position: absolute;
		top: 0; bottom: 0;
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
		box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.35), inset 0 0 8px rgba(248, 113, 113, 0.25);
		pointer-events: none;
		mix-blend-mode: normal;
	}
	.symbol-loupe {
		position: fixed;
		z-index: 80;
		width: 120px;
		height: 120px;
		margin-left: -60px;
		margin-top: -150px; /* sit above the cursor */
		border-radius: 50%;
		overflow: hidden;
		pointer-events: none;
		box-shadow:
			0 0 0 2px rgba(167, 139, 250, 0.85),
			0 12px 28px rgba(0, 0, 0, 0.55),
			0 0 0 1px rgba(0, 0, 0, 0.4);
		background: #0a0a09;
	}
	.symbol-loupe canvas {
		display: block;
		width: 120px;
		height: 120px;
	}
	.page-hit {
		position: absolute;
		z-index: 15;
		top: 56px;
		bottom: 8px;
		/* Generous invisible hit targets for easy page turns while practicing */
		width: min(22vw, 160px);
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
		color: #b8b8b0;
		box-shadow: 0 18px 50px rgba(0, 0, 0, 0.42);
    	border: 1px solid rgba(255, 255, 255, 0.08);
    	border-radius: 14px;
    	background: rgba(25, 25, 22, 0.78);
    	backdrop-filter: blur(18px);
	}

	.loading.subtle {
		padding: 8px;
		background: rgba(28, 28, 25, 0.55);
		box-shadow: none;
		pointer-events: none;
	}
	.loading span:first-child {
		width: 18px;
		height: 18px;
		border: 2px solid #55554e;
		border-top-color: #fff;
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	.error strong {
		color: #fff;
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
		background: #fff;
		color: #111;
	}
	.annotation-toggle {
		position: absolute;
		z-index: 32;
		left: 16px;
		bottom: 16px;
		width: 42px;
		height: 42px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 12px;
		background: rgba(28, 28, 25, 0.94);
		color: #ddd;
		display: grid;
		place-items: center;
		box-shadow: 0 12px 30px rgba(0, 0, 0, 0.35);
		cursor: pointer;
	}
	.annotation-bar {
		position: absolute;
		z-index: 35;
		left: 50%;
		bottom: 8px;
		transform: translateX(-50%);
		display: flex;
		align-items: center;
		gap: 5px;
		max-width: calc(100% - 24px);
		padding: 5px;
		box-shadow: 0 18px 50px rgba(0, 0, 0, 0.42);
    	border: 1px solid rgba(255, 255, 255, 0.08);
    	border-radius: 14px;
    	background: rgba(25, 25, 22, 0.78);
    	backdrop-filter: blur(18px);
	}
	.tool-button {
		min-width: 48px;
		padding: 8px 8px;
		flex-direction: column;
		gap: 3px;
		font-size: 9px;
	}
	.divider {
		width: 1px;
		height: 31px;
		background: rgba(255, 255, 255, 0.08);
	}
	.compact {
		gap: 4px;
	}
	.color-row {
		margin-left: 3px;
	}
	.swatch {
		width: 22px;
		height: 22px;
		border: 2px solid transparent;
		border-radius: 50%;
		background: var(--swatch);
		cursor: pointer;
		flex-shrink: 0;
	}
	.swatch.selected {
		border-color: #fff;
		box-shadow: 0 0 0 1px #111;
	}
	.range-label {
		display: flex;
		align-items: center;
		gap: 4px;
		color: #888880;
		font-size: 9px;
		white-space: nowrap;
	}
	.range-label input {
		width: 68px;
	}
	.size-slider {
		gap: 6px;
		padding: 0 4px;
	}
	.size-slider .size-value {
		min-width: 14px;
		text-align: center;
		color: #c8c8c0;
		font-variant-numeric: tabular-nums;
	}
	.size-slider input[type='range'] {
		-webkit-appearance: none;
		appearance: none;
		width: 72px;
		height: 4px;
		border-radius: 999px;
		background: linear-gradient(90deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.28));
		outline: none;
		cursor: pointer;
	}
	.size-slider input[type='range']::-webkit-slider-thumb {
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
	.size-slider input[type='range']::-moz-range-thumb {
		width: 14px;
		height: 14px;
		border-radius: 50%;
		background: #f4f4f0;
		border: 2px solid #1a1a17;
		box-shadow: 0 1px 4px rgba(0, 0, 0, 0.45);
		cursor: pointer;
	}
	.size-slider input[type='range']::-moz-range-track {
		height: 4px;
		border-radius: 999px;
		background: linear-gradient(90deg, rgba(255, 255, 255, 0.12), rgba(255, 255, 255, 0.28));
	}
	.color-more-wrap {
		position: relative;
		display: inline-flex;
	}
	.more-swatch {
		display: grid;
		place-items: center;
		align-items: center;
		background: rgba(255, 255, 255, 0.08);
		border: 1px dashed rgba(255, 255, 255, 0.28);
	}
	.more-swatch.open {
		border-style: solid;
		border-color: rgba(255, 255, 255, 0.45);
	}
	.more-plus {
		font-size: 12px;
		line-height: 1;
		color: #c8c8c0;
		font-weight: 600;
		transform: translate(0px,-1px);
	}
	.color-popup {
		position: absolute;
		bottom: calc(100% + 8px);
		left: 50%;
		transform: translateX(-50%);
		display: flex;
		gap: 6px;
		padding: 8px;
		border-radius: 12px;
		border: 1px solid rgba(255, 255, 255, 0.1);
		background: rgba(22, 22, 19, 0.96);
		box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
		backdrop-filter: blur(16px);
		z-index: 40;
	}
	.symbol-sheet {
		position: absolute;
		z-index: 46;
		right: 8px;
		bottom: 80px;
		width: min(440px, calc(100% - 12px));
		max-height: min(48vh, 420px);
		display: flex;
		flex-direction: column;
		overflow: hidden;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 18px;
		background: rgba(16, 16, 14, 0.98);
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(20px);
	}
	.symbol-sheet-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		padding: 12px 12px 8px;
	}
	.symbol-sheet-title {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.symbol-sheet-title strong {
		font-size: 14px;
		font-weight: 650;
	}
	.symbol-sheet-title span {
		font-size: 11px;
		color: #7a7a72;
	}
	.symbol-cats {
		display: flex;
		gap: 4px;
		padding: 0 12px 8px;
		overflow-x: auto;
		scrollbar-width: none;
	}
	.symbol-cats::-webkit-scrollbar { display: none; }
	.symbol-cats button {
		flex-shrink: 0;
		height: 30px;
		padding: 0 12px;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: #8a8a82;
		font-size: 12px;
		font-weight: 500;
		cursor: pointer;
	}
	.symbol-cats button.active {
		background: var(--sonora-accent);
		color: #11110f;
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
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 10px;
		background: #0a0a09;
		color: #fff;
		padding: 0 12px;
		font-size: 13px;
		outline: none;
	}
	.symbol-size-control {
		display: flex;
		align-items: center;
		gap: 6px;
		color: #8a8a82;
		font-size: 11px;
		white-space: nowrap;
	}
	.symbol-size-control input[type='range'] {
		width: 72px;
	}
	.symbol-tray {
		flex: 1;
		min-height: 120px;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(72px, 1fr));
		gap: 6px;
		padding: 4px 12px 8px;
		overflow: auto;
		align-content: start;
	}
	.symbol-tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		min-height: 64px;
		padding: 8px 4px;
		border: 1px solid transparent;
		border-radius: 12px;
		background: rgba(255, 255, 255, 0.03);
		color: #f4f4f0;
		cursor: pointer;
	}
	.symbol-tile .glyph {
		font: 28px/1 Leland, serif;
	}
	.symbol-tile .name {
		font-size: 9px;
		color: #8a8a82;
		text-align: center;
		line-height: 1.2;
		max-width: 100%;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.symbol-tile.selected,
	.symbol-tile:hover {
		border-color: rgba(147, 197, 253, 0.45);
		background: rgba(37, 99, 235, 0.16);
	}
	.symbol-tile.selected .name,
	.symbol-tile:hover .name {
		color: #c8d9f5;
	}
	.symbol-empty {
		grid-column: 1 / -1;
		margin: 16px 0;
		text-align: center;
		color: #7a7a72;
		font-size: 13px;
	}
	@media (max-width: 900px) {
		.symbol-sheet {
			bottom: 58px;
			max-height: min(52vh, 380px);
			border-radius: 16px 16px 12px 12px;
		}
		.symbol-tile .name {
			font-size: 8px;
		}
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
		border: 1px solid rgba(255, 255, 255, 0.14);
		border-radius: 14px;
		background: rgba(18, 18, 16, 0.98);
		box-shadow: 0 16px 40px rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(16px);
		pointer-events: auto;
	}
	.text-editor-label {
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: #8a8a82;
		flex-shrink: 0;
	}
	.text-editor-floating input {
		flex: 1;
		min-width: 0;
		border: 0;
		outline: 0;
		background: rgba(255, 255, 255, 0.06);
		color: #fff;
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
		color: #aaa;
		cursor: pointer;
		display: grid;
		place-items: center;
		flex-shrink: 0;
	}
	.text-editor-floating button.text-editor-save {
		background: rgba(34, 197, 94, 0.18);
		color: #86efac;
	}
	.text-editor-floating button:hover {
		background: rgba(255, 255, 255, 0.08);
		color: #fff;
	}
	.text-editor-floating button.text-editor-save:hover {
		background: rgba(34, 197, 94, 0.32);
		color: #bbf7d0;
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
		background: rgba(30, 30, 27, 0.98);
		border: 1px solid rgba(255, 255, 255, 0.1);
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
		color: #fff;
		font-size: 11px;
	}
	.search-panel span {
		color: #85857d;
		font-size: 9px;
		white-space: nowrap;
	}
	.settings-backdrop {
		position: absolute;
		inset: 0;
		z-index: 54;
		background: rgba(0, 0, 0, 0.35);
		backdrop-filter: blur(2px);
		animation: settings-in 160ms cubic-bezier(.2,.8,.2,1);
	}
	.settings-card {
		position: absolute;
		z-index: 55;
		top: 56px;
		right: 12px;
		width: min(320px, calc(100vw - 24px));
		max-height: calc(100% - 80px);
		overflow: auto;
		display: flex;
		flex-direction: column;
		gap: 0;
		padding: 0;
		border: 1px solid rgba(255, 255, 255, 0.1);
		border-radius: 16px;
		background: #1c1c19;
		box-shadow: 0 24px 60px rgba(0, 0, 0, 0.55);
		font-size: 12px;
		animation: settings-in 180ms cubic-bezier(.2,.8,.2,1);
	}
	.settings-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 14px 14px 10px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	}
	.settings-header strong {
		font-size: 13px;
		font-weight: 600;
		letter-spacing: 0.01em;
	}
	.settings-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		padding: 0 4px 8px;
	}
	.settings-actions .text-button {
		background: rgba(255, 255, 255, 0.06);
	}
	.settings-section {
		padding: 12px 14px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
	}
	.settings-section h3 {
		margin: 0 0 10px;
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: #8a8a82;
	}
	.settings-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 10px;
		color: #d4d4cc;
	}
	.settings-row:last-child {
		margin-bottom: 0;
	}
	.settings-row.disabled {
		opacity: 0.45;
		pointer-events: none;
	}
	.settings-row .label-title {
		display: block;
		font-size: 12px;
		font-weight: 500;
		color: #f0f0ea;
	}
	.settings-row .label-desc {
		display: block;
		margin-top: 2px;
		font-size: 10px;
		line-height: 1.35;
		color: #8a8a82;
	}
	.settings-row input[type='checkbox'] {
		width: 18px;
		height: 18px;
		accent-color: #c2410c;
		flex-shrink: 0;
	}
	.settings-row input[type='range'] {
		flex: 1;
		min-width: 0;
		accent-color: #c2410c;
	}
	.settings-row .range-value {
		min-width: 34px;
		text-align: right;
		font-variant-numeric: tabular-nums;
		color: #aaa9a0;
		font-size: 11px;
	}
	.shortcut-list {
		margin: 0;
		padding: 0;
		list-style: none;
		display: flex;
		flex-direction: column;
		gap: 6px;
		color: #aaa9a0;
		font-size: 11px;
	}
	.shortcut-list kbd {
		display: inline-block;
		min-width: 1.4em;
		padding: 1px 5px;
		border-radius: 4px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: rgba(255, 255, 255, 0.06);
		font-size: 10px;
		font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
		color: #e8e8e0;
		text-align: center;
	}
	.settings-footer {
		padding: 12px 14px 14px;
		display: flex;
		justify-content: flex-end;
	}
	.settings-footer .text-button.primary {
		background: #c2410c;
		color: #fff;
		border: none;
		padding: 8px 16px;
		border-radius: 8px;
		font-weight: 600;
	}
	.settings-footer .text-button.primary:hover {
		background: #d97706;
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
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 10px;
		background: rgba(28, 28, 25, 0.88);
		color: #ddd;
		cursor: pointer;
		opacity: 0.55;
		transition: opacity 0.15s ease;
		backdrop-filter: blur(14px);
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
		from { opacity: 0; transform: translateY(-5px) scale(.98); }
		to { opacity: 1; transform: translateY(0) scale(1); }
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (max-width: 900px) {
		.annotation-bar {
			left: 10px;
			right: 10px;
			transform: none;
			justify-content: center;
			overflow: auto;
		}
		.tool-button {
			min-width: 42px;
		}
		.tool-button span,
		.divider,
		.range-label,
		.color-row {
			display: none;
		}
		.topbar-right .icon-button:nth-child(3),
		.topbar-right .icon-button:nth-child(4) {
			display: none;
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
		.symbol-sheet {
			max-height: 64vh;
		}
		.bottombar {
			padding: 7px;
		}
		.footer-section .text-button {
			display: none;
		}
	}
	@media print {
		.topbar,
		.bottombar,
		.annotation-bar,
		.annotation-toggle,
		.symbol-sheet,
		.search-panel,
		.settings-card,
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
