import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

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
		const request = this.blob.slice(safeBegin, safeEnd).arrayBuffer().then((buffer) => {
			if (!this.stopped) this.onDataRange(safeBegin, new Uint8Array(buffer));
		}).catch((error) => {
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
export const MAX_CANVAS_PIXELS = 16_000_000;

export type OpenedPdf = {
	document: pdfjsLib.PDFDocumentProxy;
	transport: BlobRangeTransport | null;
};

const commonOpts = { isEvalSupported: false, useWorkerFetch: false, useSystemFonts: true } as const;

async function openWithData(blob: Blob): Promise<pdfjsLib.PDFDocumentProxy> {
	const buffer = await blob.arrayBuffer();
	return pdfjsLib.getDocument({ data: buffer, ...commonOpts }).promise;
}

export async function openPdfFromUrl(url: string): Promise<OpenedPdf> {
	if (!url.trim()) throw new Error('PDF URL is empty');
	const document = await pdfjsLib.getDocument({ url, rangeChunkSize: 512 * 1024, disableAutoFetch: true, disableStream: false, disableRange: false, ...commonOpts }).promise;
	return { document, transport: null };
}

export async function openPdf(blob: Blob): Promise<OpenedPdf> {
	if (!blob || blob.size === 0) throw new Error('PDF data is empty');
	if (blob.size <= DIRECT_LOAD_LIMIT) {
		try { return { document: await openWithData(blob), transport: null }; }
		catch (error) { console.warn('Direct PDF loading failed; retrying with range loading', error); }
	}
	const transport = new BlobRangeTransport(blob);
	try {
		const document = await pdfjsLib.getDocument({ range: transport, rangeChunkSize: 2 * 1024 * 1024, disableRange: false, disableStream: true, disableAutoFetch: false, ...commonOpts }).promise;
		return { document, transport };
	} catch (error) {
		transport.abort();
		try { return { document: await openWithData(blob), transport: null }; }
		catch (fallbackError) { throw new AggregateError([error, fallbackError], 'Unable to open PDF'); }
	}
}

export async function openPdfSource(source: { url?: string; blob?: Blob }): Promise<OpenedPdf> {
	if (source.url) {
		try { return await openPdfFromUrl(source.url); }
		catch (err) { console.warn('URL PDF open failed; falling back to blob if present', err); if (!source.blob) throw err; }
	}
	if (source.blob) return openPdf(source.blob);
	throw new Error('No PDF source available');
}

export async function getPdfInfoFromSource(source: { url?: string; blob?: Blob }) {
	const { document, transport } = await openPdfSource(source);
	try {
		const totalPages = document.numPages;
		let thumbnailUrl: string | undefined;
		try { thumbnailUrl = await renderThumbnail(document); }
		catch (err) { console.warn('Thumbnail render failed', err); }
		return { totalPages, thumbnailUrl };
	} finally {
		transport?.abort();
		await document.cleanup();
	}
}

export async function getPdfInfo(blob: Blob) { return getPdfInfoFromSource({ blob }); }

async function renderThumbnail(document: pdfjsLib.PDFDocumentProxy) {
	const page = await document.getPage(1);
	try {
		const base = page.getViewport({ scale: 1 });
		const area = Math.max(1, base.width * base.height);
		const targetWidth = 180;
		let scale = targetWidth / Math.max(1, base.width);
		const maxScale = Math.sqrt(MAX_CANVAS_PIXELS / area);
		scale = Math.max(0.04, Math.min(scale, maxScale, 0.4));
		const viewport = page.getViewport({ scale });
		const canvas = globalThis.document.createElement('canvas');
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		if (canvas.width * canvas.height > MAX_CANVAS_PIXELS) throw new Error('Thumbnail canvas exceeds safe pixel budget');
		const context = canvas.getContext('2d', { alpha: false });
		if (!context) throw new Error('Canvas is unavailable');
		context.fillStyle = '#fff';
		context.fillRect(0, 0, canvas.width, canvas.height);
		await page.render({ canvas, canvasContext: context, viewport }).promise;
		return canvas.toDataURL('image/jpeg', 0.65);
	} finally { page.cleanup(); }
}
