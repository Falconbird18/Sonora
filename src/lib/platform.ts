import { invoke } from '@tauri-apps/api/core';
import { isTauri } from '@tauri-apps/api/core';

export type SonoraPlatform = 'tauri' | 'web';

export function getPlatform(): SonoraPlatform {
	return isTauri() ? 'tauri' : 'web';
}

export function isNativeApp() {
	return getPlatform() === 'tauri';
}

/**
 * Native filesystem bridge. Browser callers should continue using the
 * File System Access API through folderSync; this abstraction keeps the UI
 * independent of the transport and lets the native implementation grow
 * without another application-wide rewrite.
 */
export async function nativeReadTextFile(path: string): Promise<string> {
	if (!isNativeApp()) throw new Error('Native filesystem access is unavailable in the browser.');
	return invoke<string>('read_text_file', { path });
}
