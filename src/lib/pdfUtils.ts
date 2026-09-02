import './compat';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { isTauri } from './paths';

if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
	pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
}

function blobFilename(blob: Blob) {
	return typeof File !== 'undefined' && blob instanceof File && blob.name ? blob.name : 'score.pdf';
}

class BlobRangeTransport extends pdfjsLib.PDFDataRangeTransport {
	private pending = new Map<string, Promise<void>>();
	private stopped = false;
	constructor(private readonly blob: Blob) {
		super(blob.size, null, false, blobFilename(blob));
	}
	requestDataRange(begin: number, end: number) {
		if (this.stopped) return;
		const safeBegin = Math.max(0, Math.min(begin, this.blob.size));
		const safeEnd = Math.max(safeBegin, Math.min(end, this.blob.size));
		if (safeEnd <= safeBegin) return;
		const key = `${safeBegin}:${safeEnd}`;
		if (this.pending.has(key)) return;
		const request = this.blob
			.slice(safeBegin, safeEnd)
			.arrayBuffer()
			.then((buffer) => {
				if (!this.stopped) this.onDataRange(safeBegin, new Uint8Array(buffer));
			})
			.catch((error) => {
				if (!this.stopped) {
					console.warn('PDF range request failed', error);
					this.stopped = true;
				}
			});
		this.pending.set(key, request);
		void request.finally(() => this.pending.delete(key));
	}
	abort() {
		this.stopped = true;
		this.pending.clear();
	}
}

const DIRECT_LOAD_LIMIT = 48 * 1024 * 1024;
export const MAX_CANVAS_PIXELS = 12_000_000;
export type PdfSource = { url?: string; blob?: Blob; nativePath?: string };
export type OpenedPdf = { document: pdfjsLib.PDFDocumentProxy; transport: BlobRangeTransport | null };
const commonOpts = {
	isEvalSupported: false,
	useWorkerFetch: false,
	useSystemFonts: true,
	verbosity: 0
} as const;

function isLocalProtocolUrl(url: string) {
	return /^(asset:|file:|tauri:)/i.test(url) || /asset\.localhost|tauri\.localhost/i.test(url);
}

async function openWithData(blob: Blob): Promise<pdfjsLib.PDFDocumentProxy> {
	return pdfjsLib.getDocument({ data: new Uint8Array(await blob.arrayBuffer()), ...commonOpts }).promise;
}

async function fetchPdfBlob(url: string): Promise<Blob> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to fetch PDF (${response.status})`);
	const blob = await response.blob();
	if (!blob.size) throw new Error('Fetched PDF was empty');
	return blob;
}

async function readNativePdf(path: string): Promise<Blob> {
	const { invoke } = await import('@tauri-apps/api/core');
	const bytes = await invoke<number[] | Uint8Array>('read_score_file', { path });
	const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
	return new Blob([data], { type: 'application/pdf' });
}

export async function openPdfFromUrl(url: string): Promise<OpenedPdf> {
	if (!url.trim()) throw new Error('PDF URL is empty');
	const local = isLocalProtocolUrl(url);
	try {
		const document = await pdfjsLib.getDocument({
			url,
			// Tauri's asset protocol does not reliably support HTTP range requests.
			// Asking PDF.js for ranges with auto-fetch disabled is what made
			// thumbnails and page turns hang in the desktop app.
			rangeChunkSize: 1024 * 1024,
			disableAutoFetch: false,
			disableStream: false,
			disableRange: local,
			...commonOpts
		}).promise;
		return { document, transport: null };
	} catch (error) {
		console.warn('URL PDF open failed; fetching as blob', error);
		return openPdf(await fetchPdfBlob(url));
	}
}

export async function openPdf(blob: Blob): Promise<OpenedPdf> {
	if (!blob || blob.size === 0) throw new Error('PDF data is empty');
	if (blob.size <= DIRECT_LOAD_LIMIT) {
		try {
			return { document: await openWithData(blob), transport: null };
		} catch (error) {
			console.warn('Direct PDF loading failed; retrying with range loading', error);
		}
	}
	const transport = new BlobRangeTransport(blob);
	try {
		const document = await pdfjsLib.getDocument({
			range: transport,
			rangeChunkSize: 2 * 1024 * 1024,
			disableRange: false,
			disableStream: true,
			disableAutoFetch: false,
			...commonOpts
		}).promise;
		return { document, transport };
	} catch (error) {
		transport.abort();
		try {
			return { document: await openWithData(blob), transport: null };
		} catch (fallbackError) {
			throw new AggregateError([error, fallbackError], 'Unable to open PDF');
		}
	}
}

export async function openPdfSource(source: PdfSource): Promise<OpenedPdf> {
	if (source.url) {
		try {
			return await openPdfFromUrl(source.url);
		} catch (err) {
			console.warn('URL PDF open failed; falling back', err);
			if (source.nativePath && isTauri()) {
				try {
					return await openPdf(await readNativePdf(source.nativePath));
				} catch (nativeErr) {
					console.warn('Native PDF read failed', nativeErr);
				}
			}
			if (!source.blob) throw err;
		}
	} else if (source.nativePath && isTauri()) {
		try {
			return await openPdf(await readNativePdf(source.nativePath));
		} catch (err) {
			console.warn('Native PDF read failed', err);
			if (!source.blob) throw err;
		}
	}
	if (source.blob) return openPdf(source.blob);
	throw new Error('No PDF source available');
}

export async function closePdf(opened: OpenedPdf | null | undefined) {
	if (!opened) return;
	try {
		opened.transport?.abort();
	} catch {}
	try {
		await opened.document.cleanup();
	} catch {}
}

export async function getPdfInfoFromSource(source: PdfSource) {
	const opened = await openPdfSource(source);
	try {
		const totalPages = opened.document.numPages;
		let thumbnailUrl: string | undefined;
		try {
			thumbnailUrl = await renderThumbnail(opened.document);
		} catch (err) {
			console.warn('Thumbnail render failed', err);
		}
		return { totalPages, thumbnailUrl };
	} finally {
		await closePdf(opened);
	}
}

export async function getPdfInfo(blob: Blob) {
	return getPdfInfoFromSource({ blob });
}

async function renderThumbnail(document: pdfjsLib.PDFDocumentProxy) {
	const page = await document.getPage(1);
	try {
		const base = page.getViewport({ scale: 1 });
		const area = Math.max(1, base.width * base.height);
		let scale = 160 / Math.max(1, base.width);
		scale = Math.max(0.04, Math.min(scale, Math.sqrt(MAX_CANVAS_PIXELS / area), 0.35));
		const viewport = page.getViewport({ scale });
		const canvas = globalThis.document.createElement('canvas');
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		if (canvas.width * canvas.height > MAX_CANVAS_PIXELS) {
			throw new Error('Thumbnail canvas exceeds safe pixel budget');
		}
		const context = canvas.getContext('2d', { alpha: false });
		if (!context) throw new Error('Canvas is unavailable');
		context.fillStyle = '#fff';
		context.fillRect(0, 0, canvas.width, canvas.height);
		await page.render({ canvas, canvasContext: context, viewport }).promise;
		const url = canvas.toDataURL('image/jpeg', 0.58);
		canvas.width = 0;
		canvas.height = 0;
		return url;
	} finally {
		try {
			page.cleanup();
		} catch {}
	}
}
