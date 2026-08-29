import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

// Ensure the worker is configured in every entry that uses PDF.js.
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
	pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
}

class BlobRangeTransport extends pdfjsLib.PDFDataRangeTransport {
	private pending = new Map<string, Promise<void>>();
	private stopped = false;

	constructor(private readonly blob: Blob) {
		super(blob.size, null, false, blob.name || 'score.pdf');
	}

	requestDataRange(begin: number, end: number) {
		if (this.stopped) return;
		const key = `${begin}:${end}`;
		if (this.pending.has(key)) return;
		const request = this.blob.slice(begin, end).arrayBuffer().then((buffer) => {
			if (!this.stopped) {
				this.onDataRange(begin, new Uint8Array(buffer));
				this.onDataProgress(Math.min(end, this.blob.size), this.blob.size);
			}
		});
		this.pending.set(key, request);
		void request.catch((error) => !this.stopped && this.onError(error)).finally(() => this.pending.delete(key));
	}

	abort() {
		this.stopped = true;
		this.pending.clear();
	}
}

const DIRECT_LOAD_LIMIT = 64 * 1024 * 1024;
/** Soft cap for canvas pixels (width * height * dpr^2). Browsers often fail above ~16–32M. */
export const MAX_CANVAS_PIXELS = 16_000_000;

async function openWithData(blob: Blob) {
	return pdfjsLib.getDocument({
		data: new Uint8Array(await blob.arrayBuffer()),
		isEvalSupported: false,
		useWorkerFetch: false,
		useSystemFonts: true
	}).promise;
}

export async function openPdf(blob: Blob) {
	if (!blob || blob.size === 0) {
		throw new Error('PDF data is empty');
	}

	if (blob.size <= DIRECT_LOAD_LIMIT) {
		try {
			const document = await openWithData(blob);
			return { document, transport: null as BlobRangeTransport | null };
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
			isEvalSupported: false,
			useWorkerFetch: false,
			useSystemFonts: true
		}).promise;
		return { document, transport };
	} catch (error) {
		transport.abort();
		try {
			const document = await openWithData(blob);
			return { document, transport: null as BlobRangeTransport | null, fallback: error };
		} catch (fallbackError) {
			throw new AggregateError([error, fallbackError], 'Unable to open PDF');
		}
	}
}

export async function getPdfInfo(blob: Blob) {
	const { document, transport } = await openPdf(blob);
	try {
		const totalPages = document.numPages;
		let thumbnailUrl: string | undefined;
		try {
			thumbnailUrl = await renderThumbnail(document);
		} catch (err) {
			console.warn('Thumbnail render failed', err);
		}
		return { totalPages, thumbnailUrl };
	} finally {
		transport?.abort();
		await document.destroy();
	}
}

async function renderThumbnail(document: pdfjsLib.PDFDocumentProxy) {
	const page = await document.getPage(1);
	try {
		const base = page.getViewport({ scale: 1 });
		const area = Math.max(1, base.width * base.height);
		// Target ~220px-wide thumbs; never exceed pixel budget (including dpr).
		const dpr = Math.min(globalThis.devicePixelRatio || 1, 1.5);
		const targetWidth = 220;
		let scale = targetWidth / Math.max(1, base.width);
		const maxScale = Math.sqrt(MAX_CANVAS_PIXELS / (area * dpr * dpr));
		scale = Math.min(scale, maxScale, 0.5);
		scale = Math.max(0.05, scale);

		const viewport = page.getViewport({ scale });
		const canvas = globalThis.document.createElement('canvas');
		const widthPx = Math.ceil(viewport.width);
		const heightPx = Math.ceil(viewport.height);
		canvas.width = Math.ceil(widthPx * dpr);
		canvas.height = Math.ceil(heightPx * dpr);
		if (canvas.width * canvas.height > MAX_CANVAS_PIXELS) {
			throw new Error('Thumbnail canvas exceeds safe pixel budget');
		}
		const context = canvas.getContext('2d', { alpha: false });
		if (!context) throw new Error('Canvas is unavailable');
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.fillStyle = '#fff';
		context.fillRect(0, 0, widthPx, heightPx);
		await page.render({ canvas, canvasContext: context, viewport }).promise;
		return canvas.toDataURL('image/jpeg', 0.72);
	} finally {
		page.cleanup();
	}
}
