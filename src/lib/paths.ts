import { convertFileSrc } from '@tauri-apps/api/core';

export function isTauri() {
	return typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;
}

export function joinNativePath(root: string, relative: string) {
	const sep = root.includes('\\') ? '\\' : '/';
	const base = root.replace(/[/\\]+$/, '');
	const rel = relative
		.replace(/^[/\\]+/, '')
		.replace(/\\/g, sep)
		.replace(/\//g, sep);
	return `${base}${sep}${rel}`;
}

/** Build a webview-loadable URL for a native filesystem path (no IPC byte copy). */
export function nativeFileUrl(absolutePath: string): string {
	return convertFileSrc(absolutePath);
}
