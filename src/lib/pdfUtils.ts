import * as pdfjsLib from 'pdfjs-dist';

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

async function openWithData(blob: Blob) {
	return pdfjsLib.getDocument({
		data: new Uint8Array(await blob.arrayBuffer()),
		isEvalSupported: false,
		useWorkerFetch: false,
		useSystemFonts: true
	}).promise;
}

export async function openPdf(blob: Blob) {
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
		return { totalPages: document.numPages, thumbnailUrl: await renderThumbnail(document) };
	} finally {
		transport?.abort();
		await document.destroy();
	}
}

async function renderThumbnail(document: pdfjsLib.PDFDocumentProxy) {
	const page = await document.getPage(1);
	try {
		const viewport = page.getViewport({ scale: 0.3 });
		const canvas = document.createElement('canvas');
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		canvas.width = Math.ceil(viewport.width * dpr);
		canvas.height = Math.ceil(viewport.height * dpr);
		const context = canvas.getContext('2d', { alpha: false });
		if (!context) throw new Error('Canvas is unavailable');
		context.setTransform(dpr, 0, 0, dpr, 0, 0);
		context.fillStyle = '#fff';
		context.fillRect(0, 0, viewport.width, viewport.height);
		await page.render({ canvasContext: context, viewport }).promise;
		return canvas.toDataURL('image/jpeg', 0.74);
	} finally {
		page.cleanup();
	}
}
