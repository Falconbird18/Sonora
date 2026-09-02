import './compat';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
import { isTauri } from './paths';
import { pdfiumRenderer } from './pdfiumRenderer';
import type { PdfDocumentRenderer } from './pdfRenderer';

if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
}

const PDFJS_VERSION = pdfjsLib.version || '4.0.379';
const commonOpts = {
    isEvalSupported: true,
    disableFontFace: true,
    useWorkerFetch: false,
    useSystemFonts: true,
    cMapUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `https://cdn.jsdelivr.net/npm/pdfjs-dist@${PDFJS_VERSION}/standard_fonts/`,
    verbosity: 0
} as const;

export const MAX_CANVAS_PIXELS = 12_000_000;

export type PdfSource = { url?: string; blob?: Blob; nativePath?: string };

/**
 * Compatibility surface for the existing viewer while it is being migrated.
 * `document` implements the small subset of PDF.js' document/page API that
 * ScoreViewerFixed currently consumes, but all actual PDF processing is now
 * performed by PDFium.
 */
export type OpenedPdf = {
    document: pdfjsLib.PDFDocumentProxy;
    transport: null;
    renderer: PdfDocumentRenderer;
};

type PdfiumPage = {
    getViewport(options: { scale: number }): { width: number; height: number; scale: number };
    render(options: {
        canvas: HTMLCanvasElement;
        canvasContext: CanvasRenderingContext2D;
        viewport: { width: number; height: number; scale: number };
    }): { promise: Promise<void>; cancel(): void };
    getTextContent(): Promise<{ items: Array<{ str: string }> }>;
    cleanup(): void;
};

function createPdfiumDocument(renderer: PdfDocumentRenderer): pdfjsLib.PDFDocumentProxy {
    const pages: PdfiumPage[] = renderer.pages.map((info) => ({
        getViewport({ scale }) {
            return {
                width: info.width * scale,
                height: info.height * scale,
                scale
            };
        },

        render({ canvas, canvasContext, viewport }) {
            let cancelled = false;
            const task = renderer.renderPage(info.index, { scale: viewport.scale });
            const promise = task.then(async ({ blob }) => {
                if (cancelled) return;
                const bitmap = await createImageBitmap(blob);
                try {
                    if (cancelled) return;
                    canvasContext.drawImage(bitmap, 0, 0, viewport.width, viewport.height);
                } finally {
                    bitmap.close();
                }
            });

            return {
                promise,
                cancel() {
                    cancelled = true;
                }
            };
        },

        async getTextContent() {
            const text = renderer.getPageText
                ? await renderer.getPageText(info.index)
                : '';
            return { items: [{ str: text }] };
        },

        cleanup() {}
    }));

    const documentCompat = {
        numPages: renderer.pageCount,
        async getPage(pageNumber: number) {
            const page = pages[pageNumber - 1];
            if (!page) throw new Error(`PDF page ${pageNumber} does not exist`);
            return page;
        },
        async cleanup() {
            await renderer.close();
        },
        async destroy() {
            await renderer.close();
        }
    };

    return documentCompat as unknown as pdfjsLib.PDFDocumentProxy;
}

function blobFilename(blob: Blob) {
    return typeof File !== 'undefined' && blob instanceof File && blob.name ? blob.name : 'score.pdf';
}

function safeCloneUint8Array(buffer: ArrayBuffer): Uint8Array {
    const copy = new Uint8Array(buffer.byteLength);
    copy.set(new Uint8Array(buffer));
    return copy;
}

function isLocalProtocolUrl(url: string) {
    return /^(asset:|file:|tauri:)/i.test(url) || /asset\.localhost|tauri\.localhost/i.test(url);
}

async function resolveTauriUrl(pathOrUrl: string): Promise<string> {
    if (!isTauri() || /^(https?|blob|data|asset|tauri):/i.test(pathOrUrl)) return pathOrUrl;
    try {
        const { convertFileSrc } = await import('@tauri-apps/api/core');
        return convertFileSrc(pathOrUrl);
    } catch {
        return pathOrUrl;
    }
}

async function readNativePdf(path: string): Promise<Blob> {
    const { invoke } = await import('@tauri-apps/api/core');
    const bytes = await invoke<number[] | Uint8Array>('read_score_file', { path });
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes);
    return new Blob([data], { type: 'application/pdf' });
}

async function fetchPdfBlob(url: string): Promise<Blob> {
    const resolvedUrl = await resolveTauriUrl(url);
    const response = await fetch(resolvedUrl);
    if (!response.ok) throw new Error(`Failed to fetch PDF (${response.status})`);
    const blob = await response.blob();
    if (!blob.size) throw new Error('Fetched PDF was empty');
    return blob;
}

async function openPdfBytes(data: Uint8Array): Promise<OpenedPdf> {
    if (!data.byteLength) throw new Error('PDF data is empty');
    const renderer = await pdfiumRenderer.open(data, `score-${Date.now()}`);
    return {
        renderer,
        transport: null,
        document: createPdfiumDocument(renderer)
    };
}

export async function openPdf(blob: Blob): Promise<OpenedPdf> {
    return openPdfBytes(new Uint8Array(await blob.arrayBuffer()));
}

export async function openPdfFromUrl(url: string): Promise<OpenedPdf> {
    if (!url.trim()) throw new Error('PDF URL is empty');
    return openPdf(await fetchPdfBlob(url));
}

export async function openPdfSource(source: PdfSource): Promise<OpenedPdf> {
    if (source.nativePath && isTauri()) {
        try {
            return await openPdf(await readNativePdf(source.nativePath));
        } catch (err) {
            console.warn('Native IPC score read failed; falling back to URL/blob', err);
        }
    }
    if (source.url) {
        try {
            return await openPdfFromUrl(source.url);
        } catch (err) {
            console.warn('URL PDF open failed', err);
            if (!source.blob) throw err;
        }
    }
    if (source.blob) return openPdf(source.blob);
    throw new Error('No valid PDF source available');
}

export async function closePdf(opened: OpenedPdf | null | undefined) {
    if (!opened) return;
    try {
        await opened.renderer.close();
    } catch {}
}

export async function readPdfSource(source: PdfSource): Promise<Uint8Array> {
    let blob: Blob;

    if (source.nativePath && isTauri()) {
        try {
            blob = await readNativePdf(source.nativePath);
        } catch (err) {
            console.warn('Native IPC score read failed; falling back to URL/blob', err);
            if (source.url) blob = await fetchPdfBlob(source.url);
            else if (source.blob) blob = source.blob;
            else throw err;
        }
    } else if (source.url) {
        try {
            blob = await fetchPdfBlob(source.url);
        } catch (err) {
            console.warn('URL PDF fetch failed; falling back to blob', err);
            if (!source.blob) throw err;
            blob = source.blob;
        }
    } else if (source.blob) {
        blob = source.blob;
    } else {
        throw new Error('No valid PDF source available');
    }

    if (!blob.size) throw new Error('PDF data is empty');
    return new Uint8Array(await blob.arrayBuffer());
}

async function renderPdfiumThumbnail(document: PdfDocumentRenderer) {
    const firstPage = document.pages[0];
    if (!firstPage) throw new Error('PDF contains no pages');

    const scale = Math.max(0.04, Math.min(160 / Math.max(1, firstPage.width), 0.35));
    const rendered = await document.renderPage(0, { scale });
    const bitmap = await createImageBitmap(rendered.blob);
    try {
        const canvas = globalThis.document.createElement('canvas');
        canvas.width = Math.max(1, Math.ceil(bitmap.width));
        canvas.height = Math.max(1, Math.ceil(bitmap.height));
        if (canvas.width * canvas.height > MAX_CANVAS_PIXELS) {
            throw new Error('Thumbnail exceeds safe pixel budget');
        }
        const context = canvas.getContext('2d', { alpha: false });
        if (!context) throw new Error('Canvas is unavailable');
        context.fillStyle = '#fff';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(bitmap, 0, 0);
        const url = canvas.toDataURL('image/jpeg', 0.58);
        canvas.width = 0;
        canvas.height = 0;
        return url;
    } finally {
        bitmap.close();
    }
}

export async function getPdfInfoFromSource(source: PdfSource) {
    const bytes = await readPdfSource(source);
    const renderer = await pdfiumRenderer.open(bytes, 'metadata');
    try {
        let thumbnailUrl: string | undefined;
        try {
            thumbnailUrl = await renderPdfiumThumbnail(renderer);
        } catch (err) {
            console.warn('PDFium thumbnail render failed', err);
        }
        return { totalPages: renderer.pageCount, thumbnailUrl };
    } finally {
        await renderer.close();
    }
}

export async function getPdfInfo(blob: Blob) {
    return getPdfInfoFromSource({ blob });
}
