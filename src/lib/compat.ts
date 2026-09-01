import * as pdfjsLib from 'pdfjs-dist';

/**
 * Project-wide compatibility declarations for browser APIs and the current
 * Svelte/PDF.js versions. The runtime PDF.js shim below restores the old
 * PDFDocumentProxy.destroy() convenience method removed in PDF.js 6.
 */

declare module 'svelte' {
	export function onMount(fn: () => void | (() => void) | Promise<void | (() => void)>): void;
}

declare module 'pdfjs-dist' {
	interface PDFDocumentProxy {
		destroy(): Promise<void>;
	}
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

export function attachPdfDestroy(document: pdfjsLib.PDFDocumentProxy): pdfjsLib.PDFDocumentProxy {
	const candidate = document as pdfjsLib.PDFDocumentProxy & {
		destroy?: () => Promise<void>;
	};

	if (!candidate.destroy) {
		candidate.destroy = () => document.loadingTask.destroy();
	}

	return document;
}

export {};
