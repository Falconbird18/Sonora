export type PdfPageInfo = {
    index: number;
    width: number;
    height: number;
};

export type PdfRenderOptions = {
    scale?: number;
    width?: number;
    height?: number;
};

export type RenderedPdfPage = {
    blob: Blob;
    width: number;
    height: number;
};

export interface PdfDocumentRenderer {
    readonly pageCount: number;
    readonly pages: readonly PdfPageInfo[];
    renderPage(pageIndex: number, options?: PdfRenderOptions): Promise<RenderedPdfPage>;
    getPageText?(pageIndex: number): Promise<string>;
    close(): Promise<void>;
}

export interface PdfRenderer {
    open(data: Uint8Array, id?: string): Promise<PdfDocumentRenderer>;
}
