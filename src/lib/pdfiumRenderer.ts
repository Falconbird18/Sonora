import type {
	PdfDocumentRenderer,
	PdfOpenOptions,
	PdfRenderOptions,
	PdfRenderer
} from './pdfRenderer';
import { PdfWorkerClient } from './pdfWorkerClient';
import type { PdfWorkerResult } from './pdfWorkerProtocol';

let viewerClient: PdfWorkerClient | undefined;
let thumbnailClient: PdfWorkerClient | undefined;
function getClient(background = false) {
	if (background) {
		if (!thumbnailClient || thumbnailClient.unavailable)
			thumbnailClient = new PdfWorkerClient();
		return thumbnailClient;
	}
	if (!viewerClient || viewerClient.unavailable)
		viewerClient = new PdfWorkerClient();
	return viewerClient;
}
async function toBitmap(result: PdfWorkerResult): Promise<ImageBitmap> {
	if (result.bitmap) return result.bitmap;
	if (result.pixels)
		return createImageBitmap(
			new ImageData(result.pixels, result.width!, result.height!)
		);
	throw Error('PDF worker returned no pixels');
}
async function toBlob(result: PdfWorkerResult): Promise<Blob> {
	if (result.blob) return result.blob;
	// Older webviews without worker OffscreenCanvas still rasterize off the UI thread.
	const bitmap = await toBitmap(result);
	try {
		const canvas = document.createElement('canvas');
		canvas.width = bitmap.width;
		canvas.height = bitmap.height;
		canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
		return await new Promise<Blob>((resolve, reject) =>
			canvas.toBlob(
				(blob) =>
					blob ? resolve(blob) : reject(Error('Thumbnail encoding failed')),
				'image/png'
			)
		);
	} finally {
		bitmap.close();
	}
}
async function openDocument(
	source: { data?: ArrayBuffer; blob?: Blob },
	id: string,
	options?: PdfOpenOptions
): Promise<PdfDocumentRenderer> {
	const client = getClient(options?.background);
	const documentId = `${id}:${crypto.randomUUID()}`;
	// Blobs are immutable shared storage; byte buffers are transferred to the worker.
	const result = await client.request({
		method: 'open',
		documentId,
		...source
	});
	const pages = result.pages!;
	let closed = false;
	function render(
		method: 'bitmap' | 'blob',
		pageIndex: number,
		options?: PdfRenderOptions
	) {
		if (closed) return Promise.reject(Error('PDF document is closed'));
		if (!pages[pageIndex])
			return Promise.reject(Error(`PDF page ${pageIndex + 1} does not exist`));
		return client.request(
			{
				method,
				documentId,
				pageIndex,
				scale: options?.scale ?? 1,
				imageType: options?.imageType
			},
			options?.priority === 'prefetch' ? 1 : 0,
			options?.signal
		);
	}
	return {
		pageCount: pages.length,
		pages,
		async renderPage(pageIndex, options) {
			const result = await render('blob', pageIndex, options);
			return {
				blob: await toBlob(result),
				width: pages[pageIndex].width,
				height: pages[pageIndex].height
			};
		},
		async renderBitmap(pageIndex, options) {
			return toBitmap(await render('bitmap', pageIndex, options));
		},
		async getPageText(pageIndex) {
			if (closed || !pages[pageIndex])
				throw Error('PDF page does not exist or document is closed');
			return (
				(await client.request({ method: 'text', documentId, pageIndex }))
					.text ?? ''
			);
		},
		async close() {
			if (closed) return;
			closed = true;
			client.cancelDocument(documentId);
			await client.request({ method: 'close', documentId });
		}
	};
}
export const pdfiumRenderer: PdfRenderer = {
	async open(data, id = 'score', options) {
		if (!data.byteLength) throw Error('PDF data is empty');
		const owned =
			options?.transfer &&
			data.buffer instanceof ArrayBuffer &&
			data.byteOffset === 0 &&
			data.byteLength === data.buffer.byteLength;
		return openDocument(
			{ data: owned ? (data.buffer as ArrayBuffer) : data.slice().buffer },
			id,
			options
		);
	},
	async openBlob(blob, id = 'score', options) {
		if (!blob.size) throw Error('PDF data is empty');
		return openDocument({ blob }, id, options);
	}
};
export async function warmPdfium() {
	await getClient().request({ method: 'warm' });
}
