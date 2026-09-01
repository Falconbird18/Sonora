import * as pdfjsLib from 'pdfjs-dist';

declare module 'pdfjs-dist' {
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

/** Safely clean up a PDF.js 6 document. */
export async function destroyPdfDocument(document: pdfjsLib.PDFDocumentProxy | null | undefined) {
	if (!document) return;
	await document.cleanup();
}

export {};
