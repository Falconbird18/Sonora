/// <reference lib="webworker" />
import { init } from '@embedpdf/pdfium';
import { PdfiumNative } from '@embedpdf/engines/pdfium';
import type {
	PdfWorkerRequest,
	PdfWorkerResponse,
	PdfWorkerResult
} from './pdfWorkerProtocol';

const scope = self as unknown as DedicatedWorkerGlobalScope;
let enginePromise: Promise<PdfiumNative> | undefined;
type Document = Awaited<
	ReturnType<ReturnType<PdfiumNative['openDocumentBuffer']>['toPromise']>
>;
const documents = new Map<string, Document>();
async function getEngine() {
	if (!enginePromise)
		enginePromise = (async () => {
			const response = await fetch('/pdfium/pdfium.wasm');
			if (!response.ok)
				throw Error(`Could not load PDFium (${response.status})`);
			const wasmBinary = await response.arrayBuffer();
			const magic = new Uint8Array(
				wasmBinary,
				0,
				Math.min(4, wasmBinary.byteLength)
			);
			if (
				magic[0] !== 0 ||
				magic[1] !== 97 ||
				magic[2] !== 115 ||
				magic[3] !== 109
			)
				throw Error('PDFium response is not WebAssembly');
			return new PdfiumNative(await init({ wasmBinary }));
		})();
	try {
		return await enginePromise;
	} catch (error) {
		enginePromise = undefined;
		throw error;
	}
}
async function execute(request: PdfWorkerRequest): Promise<PdfWorkerResult> {
	const engine = await getEngine();
	if (request.method === 'warm') return {};
	if (request.method === 'open') {
		const document = await engine
			.openDocumentBuffer({
				id: request.documentId!,
				content: request.data ?? (await request.blob!.arrayBuffer())
			})
			.toPromise();
		documents.set(request.documentId!, document);
		return {
			pages: document.pages.map((page, index) => ({
				index,
				width: page.size.width,
				height: page.size.height
			}))
		};
	}
	const document = documents.get(request.documentId!);
	if (!document) throw Error('PDF document is closed');
	if (request.method === 'close') {
		await engine.closeDocument(document).toPromise();
		documents.delete(request.documentId!);
		return {};
	}
	const page = document.pages[request.pageIndex!];
	if (!page) throw Error('PDF page does not exist');
	if (request.method === 'text')
		return {
			text: await engine.extractText(document, [request.pageIndex!]).toPromise()
		};
	const requestedScale = request.scale ?? 1;
	// PDFium clamps scaleFactor to 0.01 internally; budget the actual raster size.
	const scale = Math.max(0.01, requestedScale);
	if (
		!Number.isFinite(requestedScale) ||
		requestedScale <= 0 ||
		Math.ceil(page.size.width * scale) * Math.ceil(page.size.height * scale) >
			12_000_000
	)
		throw Error('PDF raster exceeds pixel budget');
	const raw = await engine
		.renderPageRaw(document, page, { scaleFactor: scale, dpr: 1 })
		.toPromise();
	const image = new ImageData(raw.data, raw.width, raw.height);
	if (request.method === 'blob' && typeof OffscreenCanvas !== 'undefined') {
		const canvas = new OffscreenCanvas(raw.width, raw.height);
		canvas.getContext('2d')!.putImageData(image, 0, 0);
		const blob = await canvas.convertToBlob({
			type: request.imageType ?? 'image/png',
			quality: 0.85
		});
		return { blob, width: raw.width, height: raw.height };
	}
	// No PNG encode/decode for the viewer. Snapshot the pixels before PDFium reuses memory.
	if (typeof createImageBitmap === 'function')
		return {
			bitmap: await createImageBitmap(image),
			width: raw.width,
			height: raw.height
		};
	return {
		pixels: new Uint8ClampedArray(raw.data),
		width: raw.width,
		height: raw.height
	};
}
// Serialize native PDFium calls, including async encoding, within each worker.
let queue = Promise.resolve();
scope.onmessage = ({ data }: MessageEvent<PdfWorkerRequest>) => {
	queue = queue.then(async () => {
		try {
			const result = await execute(data);
			const transfer: Transferable[] = result.bitmap
				? [result.bitmap]
				: result.pixels
					? [result.pixels.buffer]
					: [];
			scope.postMessage(
				{ id: data.id, result } satisfies PdfWorkerResponse,
				transfer
			);
		} catch (error) {
			scope.postMessage({
				id: data.id,
				error: error instanceof Error ? error.message : String(error)
			} satisfies PdfWorkerResponse);
		}
	});
};
