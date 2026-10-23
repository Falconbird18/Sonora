import { isTauri } from './paths';
import type {
	PdfDocumentRenderer,
	PdfPageInfo,
	PdfOpenOptions,
	PdfRenderOptions
} from './pdfRenderer';

export const MAX_CANVAS_PIXELS = 12_000_000;
export type PdfSource = { url?: string; blob?: Blob; nativePath?: string };
type Viewport = { scale: number; width: number; height: number };
type RenderParams = {
	canvas: HTMLCanvasElement;
	canvasContext: CanvasRenderingContext2D;
	viewport: Viewport;
	priority?: 'interactive' | 'prefetch';
};
export type PdfRenderTask = { promise: Promise<void>; cancel(): void };
export type PdfPageProxy = {
	pageNumber: number;
	getViewport(options: { scale: number }): Viewport;
	render(params: RenderParams): PdfRenderTask;
	getTextContent(): Promise<{ items: Array<{ str: string }> }>;
	cleanup(): void;
};
export type PdfDocumentProxy = {
	numPages: number;
	getPage(pageNumber: number): Promise<PdfPageProxy>;
	renderPage(
		pageIndex: number,
		options?: PdfRenderOptions
	): Promise<RenderedPdfPage>;
	renderBitmap?(
		pageIndex: number,
		options?: PdfRenderOptions
	): Promise<ImageBitmap>;
	cleanup(): Promise<void>;
};
type RenderedPdfPage = { blob: Blob; width: number; height: number };
export type OpenedPdf = { document: PdfDocumentProxy };

let rendererPromise: Promise<typeof import('./pdfiumRenderer')> | null = null;
async function getPdfiumRenderer() {
	if (!rendererPromise) rendererPromise = import('./pdfiumRenderer');
	return rendererPromise;
}

function blobFilename(blob: Blob) {
	return typeof File !== 'undefined' && blob instanceof File && blob.name
		? blob.name
		: 'score.pdf';
}
async function readNativePdf(path: string): Promise<Uint8Array> {
	const { invoke } = await import('@tauri-apps/api/core');
	return new Uint8Array(
		await invoke<ArrayBuffer>('read_score_file_binary', { path })
	);
}
function isLocalProtocolUrl(url: string) {
	return (
		/^(asset:|file:|tauri:)/i.test(url) ||
		/asset\.localhost|tauri\.localhost/i.test(url)
	);
}
async function resolveTauriUrl(pathOrUrl: string): Promise<string> {
	if (!isTauri() || /^(https?|blob|data|asset|tauri):/i.test(pathOrUrl))
		return pathOrUrl;
	try {
		const { convertFileSrc } = await import('@tauri-apps/api/core');
		return convertFileSrc(pathOrUrl);
	} catch {
		return pathOrUrl;
	}
}
async function fetchPdfBytes(url: string): Promise<Uint8Array> {
	const response = await fetch(await resolveTauriUrl(url));
	if (!response.ok) throw new Error(`Failed to fetch PDF (${response.status})`);
	const bytes = new Uint8Array(await response.arrayBuffer());
	if (!bytes.byteLength) throw new Error('Fetched PDF was empty');
	return bytes;
}

function createPage(
	document: PdfDocumentRenderer,
	info: PdfPageInfo
): PdfPageProxy {
	return {
		pageNumber: info.index + 1,
		getViewport({ scale }) {
			const safeScale = Number.isFinite(scale) && scale > 0 ? scale : 1;
			return {
				scale: safeScale,
				width: info.width * safeScale,
				height: info.height * safeScale
			};
		},
		render({ canvas, canvasContext, viewport, priority }) {
			const controller = new AbortController();
			const promise = (async () => {
				const options: PdfRenderOptions = {
					scale: (viewport.scale * canvas.width) / viewport.width,
					priority,
					signal: controller.signal
				};
				const image = document.renderBitmap
					? await document.renderBitmap(info.index, options)
					: await createImageBitmap(
							(await document.renderPage(info.index, options)).blob
						);
				try {
					if (!controller.signal.aborted) {
						canvasContext.clearRect(0, 0, canvas.width, canvas.height);
						canvasContext.drawImage(
							image,
							0,
							0,
							viewport.width,
							viewport.height
						);
					}
				} finally {
					image.close();
				}
			})();
			return {
				promise,
				cancel() {
					controller.abort();
				}
			};
		},
		async getTextContent() {
			const text = document.getPageText
				? await document.getPageText(info.index)
				: '';
			return { items: text ? [{ str: text }] : [] };
		},
		cleanup() {}
	};
}

export async function openPdfBytes(
	bytes: Uint8Array,
	id = 'score.pdf',
	options?: PdfOpenOptions
): Promise<OpenedPdf> {
	if (!bytes.byteLength) throw new Error('PDF data is empty');
	const { pdfiumRenderer } = await getPdfiumRenderer();
	const document = await pdfiumRenderer.open(bytes, id, options);
	return wrapDocument(document);
}

function wrapDocument(document: PdfDocumentRenderer): OpenedPdf {
	const pages = document.pages;
	const proxy: PdfDocumentProxy = {
		numPages: pages.length,
		getPage(pageNumber) {
			const info = pages[pageNumber - 1];
			if (!info)
				return Promise.reject(
					new Error(`PDF page ${pageNumber} does not exist`)
				);
			return Promise.resolve(createPage(document, info));
		},
		renderPage(pageIndex, options) {
			return document.renderPage(pageIndex, options);
		},
		renderBitmap: document.renderBitmap
			? (pageIndex, options) => document.renderBitmap!(pageIndex, options)
			: undefined,
		cleanup: document.close
	};
	return { document: proxy };
}
export async function openPdf(
	blob: Blob,
	options?: PdfOpenOptions
): Promise<OpenedPdf> {
	if (!blob || blob.size === 0) throw new Error('PDF data is empty');
	const { pdfiumRenderer } = await getPdfiumRenderer();
	if (pdfiumRenderer.openBlob)
		return wrapDocument(
			await pdfiumRenderer.openBlob(blob, blobFilename(blob), options)
		);
	return openPdfBytes(
		new Uint8Array(await blob.arrayBuffer()),
		blobFilename(blob),
		{ ...options, transfer: true }
	);
}
export async function openPdfFromUrl(
	url: string,
	options?: PdfOpenOptions
): Promise<OpenedPdf> {
	if (!url.trim()) throw new Error('PDF URL is empty');
	const targetUrl = await resolveTauriUrl(url);
	return openPdfBytes(await fetchPdfBytes(targetUrl), targetUrl, {
		...options,
		transfer: true
	});
}
export async function openPdfSource(
	source: PdfSource,
	options?: PdfOpenOptions
): Promise<OpenedPdf> {
	if (source.nativePath && isTauri()) {
		try {
			return await openPdfBytes(
				await readNativePdf(source.nativePath),
				source.nativePath,
				{ ...options, transfer: true }
			);
		} catch (error) {
			console.warn(
				'Native IPC score read failed; falling back to URL/blob',
				error
			);
		}
	}
	if (source.url) {
		try {
			return await openPdfFromUrl(source.url, options);
		} catch (error) {
			console.warn('URL PDF open failed', error);
			if (!source.blob) throw error;
		}
	}
	if (source.blob) return openPdf(source.blob, options);
	throw new Error('No valid PDF source available');
}
export async function closePdf(opened: OpenedPdf | null | undefined) {
	if (!opened) return;
	try {
		await opened.document.cleanup();
	} catch {}
}
async function blobToDataUrl(blob: Blob): Promise<string> {
	if (!blob || blob.size === 0)
		throw new Error('PDFium returned an empty thumbnail');
	if (!blob.type.startsWith('image/'))
		throw new Error(
			`PDFium returned a non-image thumbnail (${blob.type || 'unknown type'})`
		);
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onerror = () =>
			reject(reader.error || new Error('Could not read rendered thumbnail'));
		reader.onload = () => {
			if (
				typeof reader.result !== 'string' ||
				!reader.result.startsWith('data:image/')
			)
				return reject(
					new Error('Rendered thumbnail could not be converted to a data URL')
				);
			resolve(reader.result);
		};
		reader.readAsDataURL(blob);
	});
}
async function renderThumbnail(document: PdfDocumentProxy) {
	const page = await document.getPage(1);
	try {
		const base = page.getViewport({ scale: 1 });
		const area = Math.max(1, base.width * base.height);
		let scale = 160 / Math.max(1, base.width);
		scale = Math.min(scale, Math.sqrt(1_000_000 / area), 0.35);
		const rendered = await document.renderPage(0, { scale });
		return await blobToDataUrl(rendered.blob);
	} finally {
		page.cleanup();
	}
}
export async function getPdfInfoFromSource(source: PdfSource) {
	const opened = await openPdfSource(source, { background: true });
	try {
		const totalPages = opened.document.numPages;
		const thumbnailUrl = await renderThumbnail(opened.document);
		return { totalPages, thumbnailUrl };
	} finally {
		await closePdf(opened);
	}
}
export async function getPdfInfo(blob: Blob) {
	return getPdfInfoFromSource({ blob });
}
export async function warmPdfRenderer() {
	await (await getPdfiumRenderer()).warmPdfium();
}
