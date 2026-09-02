import { init, DEFAULT_PDFIUM_WASM_URL } from '@embedpdf/pdfium';
import { PdfiumNative, PdfEngine } from '@embedpdf/engines/pdfium';
import { browserImageDataToBlobConverter } from '@embedpdf/engines/converters';
import type {
    PdfDocumentRenderer,
    PdfPageInfo,
    PdfRenderOptions,
    PdfRenderer,
    RenderedPdfPage
} from './pdfRenderer';

let enginePromise: Promise<PdfEngine> | null = null;

/**
 * PDFium-backed renderer.
 *
 * PDF.js remains untouched during the first migration step. This module is the
 * new rendering boundary: the viewer will eventually depend on this interface
 * rather than PDFDocumentProxy/RenderTask. Keeping the boundary small lets us
 * switch the viewer incrementally without mixing the two rendering models.
 */
async function getEngine(): Promise<PdfEngine> {
    if (!enginePromise) {
        enginePromise = (async () => {
            const response = await fetch(DEFAULT_PDFIUM_WASM_URL);
            if (!response.ok) {
                throw new Error(`Could not load PDFium WebAssembly (${response.status})`);
            }
            const wasmBinary = await response.arrayBuffer();
            const module = await init({ wasmBinary });
            const native = new PdfiumNative(module);
            return new PdfEngine(native, {
                imageConverter: browserImageDataToBlobConverter
            });
        })();
    }
    return enginePromise;
}

function renderOptions(options?: PdfRenderOptions) {
    if (options?.width || options?.height) {
        return {
            ...(options.width ? { width: Math.max(1, Math.round(options.width)) } : {}),
            ...(options.height ? { height: Math.max(1, Math.round(options.height)) } : {})
        };
    }
    return { scale: options?.scale ?? 1 };
}

export const pdfiumRenderer: PdfRenderer = {
    async open(data: Uint8Array, id = `score-${Date.now()}`): Promise<PdfDocumentRenderer> {
        const engine = await getEngine();
        const document = await engine
            .openDocumentBuffer({ id, content: data })
            .toPromise();

        const pages: PdfPageInfo[] = document.pages.map((page, index) => ({
            index,
            width: page.width,
            height: page.height
        }));

        return {
            pageCount: pages.length,
            pages,

            async renderPage(pageIndex, options): Promise<RenderedPdfPage> {
                const page = document.pages[pageIndex];
                if (!page) throw new Error(`PDF page ${pageIndex + 1} does not exist`);

                const blob = await engine
                    .renderPage(document, page, renderOptions(options))
                    .toPromise();

                return {
                    blob,
                    width: page.width,
                    height: page.height
                };
            },

            async getPageText(pageIndex) {
                const page = document.pages[pageIndex];
                if (!page) throw new Error(`PDF page ${pageIndex + 1} does not exist`);
                return engine.extractPageText
                    ? await engine.extractPageText(document, page).toPromise()
                    : '';
            },

            async close() {
                await engine.closeDocument(document).toPromise();
            }
        };
    }
};

export async function warmPdfium() {
    await getEngine();
}
