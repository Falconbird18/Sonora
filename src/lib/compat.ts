import * as pdfjsLib from 'pdfjs-dist';

declare module 'pdfjs-dist/types/src/display/api' {
	interface PDFDocumentProxy {
		destroy(): Promise<void>;
	}
}

declare module 'svelte' {
	export function onMount(fn: () => void | (() => void) | Promise<void | (() => void)>): void;
}

declare global {
	interface FileSystemDirectoryHandle {
		queryPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
		requestPermission(options?: { mode?: 'read' | 'readwrite' }): Promise<PermissionState>;
	}

	interface Window {
		showDirectoryPicker(options?: {
			id?: string;
			mode?: 'read' | 'readwrite';
			startIn?: FileSystemHandle | string;
		}): Promise<FileSystemDirectoryHandle>;
	}
}

/** PDF.js 6 removed the proxy destroy convenience method; cleanup is its replacement. */
const pdfDocumentPrototype = (pdfjsLib as typeof pdfjsLib & {
	PDFDocumentProxy?: { prototype: { destroy?: () => Promise<void>; cleanup?: () => Promise<void> } };
}).PDFDocumentProxy?.prototype;

if (pdfDocumentPrototype && !pdfDocumentPrototype.destroy && pdfDocumentPrototype.cleanup) {
	pdfDocumentPrototype.destroy = async function () {
		await this.cleanup?.();
	};
}

export async function destroyPdfDocument(document: pdfjsLib.PDFDocumentProxy | null | undefined) {
	if (!document) return;
	await document.cleanup();
}

export {};
