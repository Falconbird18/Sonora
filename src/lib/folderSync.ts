import { invoke } from '@tauri-apps/api/core';
import { db } from './db';
import type { FolderSource, ScoreItem } from './types';
import { getPdfInfoFromSource } from './pdfUtils';
import { isTauri, joinNativePath, nativeFileUrl } from './paths';

const ROOT_FOLDER_ID = 'library-root';
const METADATA_CONCURRENCY = 2;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

type NativeScoreFile = { path: string; relative_path: string; name: string; size: number; modified_at: number };

export function supportsDirectoryAccess() {
	return isTauri() || (typeof window !== 'undefined' && 'showDirectoryPicker' in window);
}
async function verifyBrowserPermission(handle: FileSystemDirectoryHandle) {
	const fsHandle = handle as FileSystemDirectoryHandle & { queryPermission(options: { mode: 'read' }): Promise<PermissionState>; requestPermission(options: { mode: 'read' }): Promise<PermissionState> };
	const state = await fsHandle.queryPermission({ mode: 'read' });
	if (state === 'granted') return true;
	return (await fsHandle.requestPermission({ mode: 'read' })) === 'granted';
}
export async function verifyFolderPermission(folder: FolderSource) {
	if (folder.nativePath) {
		try { await invoke<NativeScoreFile[]>('list_score_files', { path: folder.nativePath }); return true; }
		catch { return false; }
	}
	return folder.handle ? verifyBrowserPermission(folder.handle) : false;
}
async function collectBrowserPdfs(handle: FileSystemDirectoryHandle, prefix = ''): Promise<Array<{ file: File; path: string }>> {
	const result: Array<{ file: File; path: string }> = [];
	const directories: Array<{ handle: FileSystemDirectoryHandle; path: string }> = [];
	for await (const [name, entry] of handle.entries()) {
		if (name.startsWith('.') || name === 'node_modules') continue;
		const path = prefix ? `${prefix}/${name}` : name;
		if (entry.kind === 'file' && name.toLowerCase().endsWith('.pdf')) {
			try { result.push({ file: await entry.getFile(), path }); } catch (error) { console.warn('Could not read PDF', path, error); }
		} else if (entry.kind === 'directory') directories.push({ handle: entry, path });
	}
	for (const directory of directories) result.push(...(await collectBrowserPdfs(directory.handle, directory.path)));
	return result;
}
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	async function worker() {
		while (cursor < items.length) {
			const index = cursor++;
			try { results[index] = await fn(items[index]); } catch (error) { console.warn('Library item failed', error); }
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results.filter((result): result is R => result !== undefined);
}
function stableId(path: string) { return `${ROOT_FOLDER_ID}:${path}`; }
function composerFromPath(path: string) { const parts = path.split(/[/\\]/); return parts.length > 1 ? parts[parts.length - 2] : 'Unknown Composer'; }

async function removeOldRoots() {
	const folders = await db.folders.toArray();
	for (const folder of folders) {
		if (folder.id === ROOT_FOLDER_ID) continue;
		const scores = await db.scores.where('sourceFolderId').equals(folder.id).toArray();
		await db.transaction('rw', db.scores, db.annotations, db.folders, async () => {
			for (const score of scores) { await db.scores.delete(score.id); await db.annotations.where('scoreId').equals(score.id).delete(); }
			await db.folders.delete(folder.id);
		});
	}
}

export async function chooseAndAddFolder() {
	if (!supportsDirectoryAccess()) throw new Error('This environment does not support folder access.');
	let folder: FolderSource;
	const existing = await db.folders.get(ROOT_FOLDER_ID);
	if (isTauri()) {
		const path = await invoke<string | null>('pick_score_folder');
		if (!path) throw new DOMException('Folder selection cancelled', 'AbortError');
		folder = { id: ROOT_FOLDER_ID, name: path.split(/[\\/]/).filter(Boolean).pop() || 'Score Library', nativePath: path, addedAt: existing?.addedAt || Date.now(), lastSyncedAt: existing?.lastSyncedAt, autoSync: true };
	} else {
		const showDirectoryPicker = (window as typeof window & { showDirectoryPicker(options: { mode: 'read' }): Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
		const handle = await showDirectoryPicker.call(window, { mode: 'read' });
		if (!(await verifyBrowserPermission(handle))) throw new Error('Sonora was not granted access to the score folder.');
		folder = { id: ROOT_FOLDER_ID, name: handle.name, handle, addedAt: existing?.addedAt || Date.now(), lastSyncedAt: existing?.lastSyncedAt, autoSync: true };
	}
	await removeOldRoots();
	await db.folders.put(folder);
	await syncFolder(folder);
	return folder;
}

async function syncNativeFolder(folder: FolderSource) {
	if (!folder.nativePath) return { added: 0, updated: 0, removed: 0 };
	let files: NativeScoreFile[];
	try { files = await invoke<NativeScoreFile[]>('list_score_files', { path: folder.nativePath }); }
	catch (error) { console.warn('list_score_files failed', error); return { added: 0, updated: 0, removed: 0 }; }
	const existing = await db.scores.where('sourceFolderId').equals(folder.id).toArray();
	const existingById = new Map(existing.map((score) => [score.id, score]));
	const present = new Set(files.map((file) => stableId(file.relative_path)));
	const allowRemovals = files.length > 0 || existing.length === 0;
	let added = 0, updated = 0;
	const toWrite: ScoreItem[] = [];
	for (const file of files) {
		const id = stableId(file.relative_path), old = existingById.get(id);
		const changed = !old || old.fileSize !== file.size || old.fileModifiedAt !== file.modified_at || !old.nativePath;
		if (!changed && old) continue;
		const next: ScoreItem = { ...(old || {}), id, title: file.name.replace(/\.pdf$/i, ''), composer: old?.composer && old.composer !== 'Unknown Composer' ? old.composer : composerFromPath(file.relative_path), pdfBlob: undefined, pdfUrl: undefined, nativePath: file.path, thumbnailUrl: old?.thumbnailUrl, totalPages: old?.totalPages || 1, addedAt: old?.addedAt || Date.now(), lastOpenedAt: old?.lastOpenedAt || 0, favorite: old?.favorite || false, tags: old?.tags || [], collection: old?.collection || 'Library', sourceFolderId: folder.id, sourcePath: file.relative_path, fileSize: file.size, fileModifiedAt: file.modified_at };
		if (old && (old.fileSize !== file.size || old.fileModifiedAt !== file.modified_at)) { next.thumbnailUrl = undefined; next.totalPages = 1; }
		toWrite.push(next); old ? updated++ : added++;
	}
	await db.transaction('rw', db.scores, db.annotations, db.folders, async () => {
		for (const next of toWrite) await db.scores.put(next);
		if (allowRemovals) for (const old of existing) if (!present.has(old.id)) { await db.scores.delete(old.id); await db.annotations.where('scoreId').equals(old.id).delete(); }
		await db.folders.put({ ...folder, lastSyncedAt: Date.now(), autoSync: true });
	});
	return { added, updated, removed: allowRemovals ? existing.filter((score) => !present.has(score.id)).length : 0 };
}

async function syncBrowserFolder(folder: FolderSource) {
	if (!folder.handle || !(await verifyBrowserPermission(folder.handle))) return { added: 0, updated: 0, removed: 0 };
	const files = await collectBrowserPdfs(folder.handle);
	const existing = await db.scores.where('sourceFolderId').equals(folder.id).toArray();
	const existingById = new Map(existing.map((score) => [score.id, score]));
	const present = new Set(files.map(({ path }) => stableId(path)));
	const allowRemovals = files.length > 0 || existing.length === 0;
	const changed = files.filter(({ file, path }) => { const old = existingById.get(stableId(path)); return !old || old.fileSize !== file.size || old.fileModifiedAt !== file.lastModified || !old.thumbnailUrl; });
	const results = await mapConcurrent(changed, METADATA_CONCURRENCY, async ({ file, path }) => {
		const id = stableId(path), old = existingById.get(id);
		let info: { totalPages: number; thumbnailUrl?: string } | undefined;
		try { info = await getPdfInfoFromSource({ blob: file }); } catch (error) { console.warn('PDF metadata failed', path, error); }
		const next: ScoreItem = { ...(old || {}), id, title: file.name.replace(/\.pdf$/i, ''), composer: old?.composer && old.composer !== 'Unknown Composer' ? old.composer : composerFromPath(path), pdfBlob: file, thumbnailUrl: info?.thumbnailUrl || old?.thumbnailUrl, totalPages: info?.totalPages || old?.totalPages || 1, addedAt: old?.addedAt || Date.now(), lastOpenedAt: old?.lastOpenedAt || 0, favorite: old?.favorite || false, tags: old?.tags || [], collection: old?.collection || 'Library', sourceFolderId: folder.id, sourcePath: path, fileSize: file.size, fileModifiedAt: file.lastModified };
		return { next, existed: !!old };
	});
	await db.transaction('rw', db.scores, db.annotations, db.folders, async () => {
		for (const { next } of results) await db.scores.put(next);
		if (allowRemovals) for (const old of existing) if (!present.has(old.id)) { await db.scores.delete(old.id); await db.annotations.where('scoreId').equals(old.id).delete(); }
		await db.folders.put({ ...folder, lastSyncedAt: Date.now(), autoSync: true });
	});
	return { added: results.filter((result) => !result.existed).length, updated: results.filter((result) => result.existed).length, removed: allowRemovals ? existing.filter((score) => !present.has(score.id)).length : 0 };
}

export async function syncFolder(folder: FolderSource) {
	if (!(await verifyFolderPermission(folder))) return { added: 0, updated: 0, removed: 0 };
	return folder.nativePath ? syncNativeFolder(folder) : syncBrowserFolder(folder);
}

export async function syncAllFolders(force = false) {
	const folder = await db.folders.get(ROOT_FOLDER_ID);
	if (!folder || !folder.autoSync) return [];
	let needsPathBackfill = force;
	if (!needsPathBackfill && folder.nativePath) {
		try {
			const sample = await db.scores.where('sourceFolderId').equals(folder.id).limit(50).toArray();
			needsPathBackfill = sample.some((s) => !s.nativePath && !!s.sourcePath);
		} catch { needsPathBackfill = true; }
	}
	if (!force && !needsPathBackfill && folder.lastSyncedAt && Date.now() - folder.lastSyncedAt < SYNC_INTERVAL_MS) return [{ added: 0, updated: 0, removed: 0, skipped: true as const }];
	return [await syncFolder(folder)];
}

export function resolveScoreSource(score: ScoreItem, folder?: FolderSource): { url?: string; blob?: Blob; nativePath?: string } {
	if (score.pdfUrl?.length) return { url: score.pdfUrl, blob: score.pdfBlob, nativePath: score.nativePath };
	if (score.nativePath && isTauri()) return { url: nativeFileUrl(score.nativePath), nativePath: score.nativePath, blob: score.pdfBlob };
	if (isTauri() && score.sourcePath && folder?.nativePath) { const absolute = joinNativePath(folder.nativePath, score.sourcePath); return { url: nativeFileUrl(absolute), nativePath: absolute, blob: score.pdfBlob }; }
	if (score.pdfBlob?.size) return { blob: score.pdfBlob, nativePath: score.nativePath };
	return {};
}
export async function resolveScoreSourceAsync(score: ScoreItem) { let folder: FolderSource | undefined; try { folder = await db.folders.get(ROOT_FOLDER_ID); } catch (err) { console.warn('Could not load library folder', err); } return resolveScoreSource(score, folder); }
export async function removeFolder(folder: FolderSource, removeScores = false) {
	if (removeScores) { const scores = await db.scores.where('sourceFolderId').equals(folder.id).toArray(); await db.transaction('rw', db.scores, db.annotations, async () => { for (const score of scores) { await db.scores.delete(score.id); await db.annotations.where('scoreId').equals(score.id).delete(); } }); }
	await db.folders.delete(folder.id);
}
