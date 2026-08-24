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
			if (!this.stopped) this.onDataRange(begin, new Uint8Array(buffer));
		});
		this.pending.set(key, request);
		void request.catch((error) => this.onError(error)).finally(() => this.pending.delete(key));
	}

	abort() {
		this.stopped = true;
		this.pending.clear();
	}
}

export async function openPdf(blob: Blob) {
	const transport = new BlobRangeTransport(blob);
	try {
		const document = await pdfjsLib.getDocument({
			range: transport,
			rangeChunkSize: 1024 * 1024,
			disableRange: false,
			disableStream: true,
			disableAutoFetch: true,
			isEvalSupported: false,
			useWorkerFetch: false
		}).promise;
		return { document, transport };
	} catch (error) {
		transport.abort();
		const document = await pdfjsLib.getDocument({
			data: new Uint8Array(await blob.arrayBuffer()),
			isEvalSupported: false,
			useWorkerFetch: false
		}).promise;
		return { document, transport: null as BlobRangeTransport | null, fallback: error };
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
