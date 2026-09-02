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
 * Lazily initialized, process-wide PDFium engine.
 * The WASM binary is fetched only once and the engine is reused by all score
 * views and thumbnail requests.
 */
async function getEngine(): Promise<PdfEngine> {
    if (!enginePromise) {
        enginePromise = (async () => {
            const response = await fetch(DEFAULT_PDFIUM_WASM_URL);
            if (!response.ok) {
                throw new Error(`Could not load PDFium WebAssembly (${response.status})`);
            }

            const wasmBinary = await response.arrayBuffer();
            const pdfiumModule = await init({ wasmBinary });
            const native = new PdfiumNative(pdfiumModule);

            return new PdfEngine(native, {
                imageConverter: browserImageDataToBlobConverter
            });
        })();
    }

    return enginePromise;
}

function renderOptions(options?: PdfRenderOptions) {
    // Keep this adapter intentionally narrow. PDFium's high-level render API
    // accepts a scale directly, which maps naturally to Sonora's viewer scale.
    return { scale: Math.max(0.01, options?.scale ?? 1) };
}

export const pdfiumRenderer: PdfRenderer = {
    async open(data: Uint8Array, id = `score-${Date.now()}`): Promise<PdfDocumentRenderer> {
        if (!data.byteLength) throw new Error('PDF data is empty');

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
                if (!document.pages[pageIndex]) {
                    throw new Error(`PDF page ${pageIndex + 1} does not exist`);
                }
                return engine.getPageText(document, pageIndex).toPromise();
            },

            async close() {
                await engine.closeDocument(document).toPromise();
            }
        };
    }
};

/** Pre-initialize PDFium so the first score render does not pay WASM startup cost. */
export async function warmPdfium() {
    await getEngine();
}
