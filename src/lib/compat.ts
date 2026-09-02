import * as pdfjsLib from 'pdfjs-dist';

declare module 'pdfjs-dist/types/src/display/api.js' {
	interface PDFDocumentProxy {
		destroy(): Promise<void>;
		cleanup(): Promise<void>;
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

/**
 * PDF.js 5/6 removed PDFDocumentProxy.destroy(). Map it to cleanup() and
 * NEVER call loadingTask.destroy() — that tears down the shared worker and
 * blanks the library when you leave a score.
 */
const pdfDocumentPrototype = (
	pdfjsLib as typeof pdfjsLib & {
		PDFDocumentProxy?: {
			prototype: { destroy?: () => Promise<void>; cleanup?: () => Promise<void> };
		};
	}
).PDFDocumentProxy?.prototype;

if (pdfDocumentPrototype && !pdfDocumentPrototype.destroy && pdfDocumentPrototype.cleanup) {
	pdfDocumentPrototype.destroy = async function () {
		await this.cleanup?.();
	};
}

export async function destroyPdfDocument(document: pdfjsLib.PDFDocumentProxy | null | undefined) {
	if (!document) return;
	try {
		await document.cleanup();
	} catch {}
}

export {};
