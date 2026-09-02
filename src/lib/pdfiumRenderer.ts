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

// Keep the engine singleton alive for the lifetime of the app. PDFium/WASM
// initialization is expensive, and the same engine can safely serve all scores.
let enginePromise: Promise<PdfEngine<Blob>> | null = null;

type PdfTextEngine = PdfEngine<Blob> & {
    getPageText(document: unknown, pageIndex: number): { toPromise(): Promise<string> };
};

async function getEngine(): Promise<PdfEngine<Blob>> {
    if (!enginePromise) {
        enginePromise = (async () => {
            const response = await fetch(DEFAULT_PDFIUM_WASM_URL);
            if (!response.ok) {
                throw new Error(`Could not load PDFium WebAssembly (${response.status})`);
            }
            const wasmBinary = await response.arrayBuffer();
            const pdfiumModule = await init({ wasmBinary });
            const native = new PdfiumNative(pdfiumModule);
            return new PdfEngine<Blob>(native, {
                imageConverter: browserImageDataToBlobConverter
            });
        })();
    }
    return enginePromise;
}

function renderOptions(options?: PdfRenderOptions) {
    return {
        scaleFactor: Math.max(0.01, options?.scale ?? 1),
        dpr: 1,
        imageType: 'image/png' as const
    };
}

/**
 * Make a real ArrayBuffer copy instead of passing Uint8Array<ArrayBufferLike>.
 * This matters with newer TypeScript/lib.dom definitions, where a typed-array
 * buffer may legally be backed by SharedArrayBuffer and therefore is not
 * assignable to the engine's ArrayBuffer input.
 */
function toArrayBuffer(data: Uint8Array): ArrayBuffer {
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(data);
    return buffer;
}

export const pdfiumRenderer: PdfRenderer = {
    async open(data: Uint8Array, id = `score-${Date.now()}`): Promise<PdfDocumentRenderer> {
        if (!data.byteLength) throw new Error('PDF data is empty');

        const engine = await getEngine();
        const document = await engine
            .openDocumentBuffer({ id, content: toArrayBuffer(data) })
            .toPromise();

        const pages: PdfPageInfo[] = document.pages.map((page, index) => ({
            index,
            width: page.size.width,
            height: page.size.height
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
                    width: page.size.width,
                    height: page.size.height
                };
            },

            async getPageText(pageIndex) {
                if (!document.pages[pageIndex]) {
                    throw new Error(`PDF page ${pageIndex + 1} does not exist`);
                }
                // getPageText is present in EmbedPDF's runtime engine, but the
                // PdfEngine type currently exposed by 2.15.0 does not include
                // it. Keep the compatibility boundary isolated here.
                const textEngine = engine as PdfTextEngine;
                return textEngine.getPageText(document, pageIndex).toPromise();
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
