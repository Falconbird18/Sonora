export type PdfPageInfo = {
	index: number;
	width: number;
	height: number;
};

export type PdfOpenOptions = {
	background?: boolean;
	/** Transfer a wholly-owned byte buffer instead of preserving the input. Internal reads only. */
	transfer?: boolean;
};

export type PdfRenderOptions = {
	signal?: AbortSignal;
	priority?: 'interactive' | 'prefetch';
	imageType?: 'image/png' | 'image/webp';
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
	renderPage(
		pageIndex: number,
		options?: PdfRenderOptions
	): Promise<RenderedPdfPage>;
	renderBitmap?(
		pageIndex: number,
		options?: PdfRenderOptions
	): Promise<ImageBitmap>;
	getPageText?(pageIndex: number): Promise<string>;
	close(): Promise<void>;
}

export interface PdfRenderer {
	openBlob?(
		blob: Blob,
		id?: string,
		options?: PdfOpenOptions
	): Promise<PdfDocumentRenderer>;
	open(
		data: Uint8Array,
		id?: string,
		options?: PdfOpenOptions
	): Promise<PdfDocumentRenderer>;
}
