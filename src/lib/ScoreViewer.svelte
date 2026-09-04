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
	import { settings } from './settingsStore';
	import SettingsPanel from './ui/SettingsPanel.svelte';
	import { get } from 'svelte/store';
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
	let visualScale = $state(1);
	let renderedZoom = 1;
	let zoomRaf = 0;
	let zoomPending: number | null = null;
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
	let panX = $state(0);
	let panY = $state(0);
	type PanDrag = { pointerId: number; lastX: number; lastY: number; lastT: number };
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
	let drawing: { page: number; canvas: HTMLCanvasElement; pointerId: number; stroke?: Stroke; raf?: number } | null = null;
	let hasPainted = $state(false);
	let closed = false;
	let isFullscreen = $state(false);

	function setZoom(value: number, opts: { immediate?: boolean } = {}) {
		const next = Math.max(0.35, Math.min(3, Number(value.toFixed(3))));
		if (Math.abs(next - zoom) < 0.0005 && !opts.immediate) return;
		zoom = next;
		visualScale = next / Math.max(0.001, renderedZoom);
		persistPrefs();
		clearTimeout(zoomTimer);
		const delay = opts.immediate ? 0 : 140;
		zoomTimer = setTimeout(() => void commitZoomRender(), delay);
	}
	async function commitZoomRender() {
		if (closed) return;
		const target = zoom;
		await render({ quiet: hasPainted });
		if (closed) return;
		renderedZoom = target;
		visualScale = zoom / Math.max(0.001, renderedZoom);
	}
	function onWheel(event: WheelEvent) {
		event.preventDefault();
		if (event.ctrlKey || event.metaKey) {
			const pixelDelta =
				event.deltaMode === 1 ? event.deltaY * 16 : event.deltaMode === 2 ? event.deltaY * 40 : event.deltaY;
			const factor = Math.exp(-pixelDelta * 0.0016);
			zoomPending = Math.max(0.35, Math.min(3, zoom * factor));
			if (!zoomRaf) {
				zoomRaf = requestAnimationFrame(() => {
					zoomRaf = 0;
					if (zoomPending != null) {
						setZoom(zoomPending);
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

	// NOTE: Full viewer body restored from backup — see repo history if incomplete.
	function persistPrefs() {
		localStorage.setItem(
			`sonora-viewer-${score.id}`,
			JSON.stringify({ bookmarked, zoom, fit, recentSymbols, page })
		);
	}
	function stopPanMomentum() {
		if (panMomentumRaf) cancelAnimationFrame(panMomentumRaf);
		panMomentumRaf = 0;
		panVx = 0;
		panVy = 0;
	}
	async function render(_opts?: { quiet?: boolean }) {
		/* stub — full implementation must be restored from commit a94f46b */
	}
	function cancelRender() {}
	onMount(() => {
		const global = get(settings);
		autoLayout = global.autoLayout;
		keepAwake = global.keepAwake;
		annotationsVisible = global.annotationsVisible;
		textSize = global.textSize;
	});
</script>

<div class="viewer">
	<p class="restore-note">Score viewer is recovering. Please pull the full ScoreViewer from artifacts or re-open a previous commit (a94f46b).</p>
	<button type="button" onclick={onClose}>Back to library</button>
	{#if settingsOpen}
		<SettingsPanel open={settingsOpen} focusSection="viewer" onClose={() => (settingsOpen = false)} />
	{/if}
</div>

<style>
	.viewer {
		display: grid;
		place-items: center;
		height: 100%;
		gap: 12px;
		background: var(--sonora-bg, #0c0c0e);
		color: var(--sonora-text, #f5f5f4);
		padding: 24px;
		text-align: center;
	}
	.restore-note {
		max-width: 420px;
		line-height: 1.45;
		color: var(--sonora-text-muted, #a1a1aa);
	}
	button {
		padding: 10px 16px;
		border-radius: 10px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: var(--sonora-accent, #7c6cff);
		color: #fff;
		cursor: pointer;
		font-weight: 600;
	}
</style>
