import type { PdfPageInfo } from './pdfRenderer';
export type PdfWorkerRequest = {
	id: number;
	method: 'warm' | 'open' | 'bitmap' | 'blob' | 'text' | 'close';
	documentId?: string;
	data?: ArrayBuffer;
	blob?: Blob;
	pageIndex?: number;
	scale?: number;
	imageType?: 'image/png' | 'image/webp';
};
export type PdfWorkerResult = {
	pages?: PdfPageInfo[];
	bitmap?: ImageBitmap;
	pixels?: Uint8ClampedArray<ArrayBuffer>;
	blob?: Blob;
	width?: number;
	height?: number;
	text?: string;
};
export type PdfWorkerResponse = {
	id: number;
	result?: PdfWorkerResult;
	error?: string;
};
