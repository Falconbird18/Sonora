import { db } from './db';
import type { FolderSource, ScoreItem } from './types';
import { getPdfInfo } from './pdfUtils';

const PDF = '.pdf';
const METADATA_CONCURRENCY = 3;
const FOLDER_CONCURRENCY = 2;

export async function chooseAndAddFolder() {
	if (!('showDirectoryPicker' in window)) throw new Error('Folder synchronization requires a browser with the File System Access API.');
	const handle = await window.showDirectoryPicker({ mode: 'read' });
	const permission = await handle.requestPermission({ mode: 'read' });
	if (permission !== 'granted') throw new Error('Sonora was not granted access to this folder.');
	const folder: FolderSource = { id: crypto.randomUUID(), name: handle.name, handle, addedAt: Date.now(), autoSync: true };
	await db.folders.put(folder);
	await syncFolder(folder);
	return folder;
}

export async function verifyFolderPermission(folder: FolderSource) {
	const state = await folder.handle.queryPermission({ mode: 'read' });
	if (state === 'granted') return true;
	return (await folder.handle.requestPermission({ mode: 'read' })) === 'granted';
}

async function collectPdfs(handle: FileSystemDirectoryHandle, prefix = ''): Promise<Array<{ file: File; path: string }>> {
	const result: Array<{ file: File; path: string }> = [];
	const directories: Array<{ handle: FileSystemDirectoryHandle; path: string }> = [];
	for await (const [name, entry] of handle.entries()) {
		if (name.startsWith('.') || name === 'node_modules') continue;
		const path = prefix ? `${prefix}/${name}` : name;
		if (entry.kind === 'file' && name.toLowerCase().endsWith(PDF)) {
			try { result.push({ file: await entry.getFile(), path }); } catch (error) { console.warn('Could not read PDF', path, error); }
		} else if (entry.kind === 'directory') {
			directories.push({ handle: entry, path });
		}
	}
	const nested = await Promise.all(directories.map(({ handle: child, path }) => collectPdfs(child, path)));
	for (const files of nested) result.push(...files);
	return result;
}

function composerFromPath(path: string) {
	const parts = path.split('/');
	return parts.length > 1 ? parts[parts.length - 2] : 'Unknown Composer';
}

function stableId(folderId: string, path: string) { return `${folderId}:${path}`; }

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	async function worker() {
		while (cursor < items.length) {
			const index = cursor++;
			try { results[index] = await fn(items[index]); } catch (error) { console.warn('Folder item failed', error); }
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results.filter((result): result is R => result !== undefined);
}

export async function syncFolder(folder: FolderSource) {
	if (!(await verifyFolderPermission(folder))) return { added: 0, updated: 0, removed: 0 };
	const files = await collectPdfs(folder.handle);
	const existing = await db.scores.where('sourceFolderId').equals(folder.id).toArray();
	const existingById = new Map(existing.map((score) => [score.id, score]));
	const present = new Set(files.map(({ path }) => stableId(folder.id, path)));

	const changed = files.filter(({ file, path }) => {
		const old = existingById.get(stableId(folder.id, path));
		return !old || old.fileSize !== file.size || old.fileModifiedAt !== file.lastModified;
	});

	const results = await mapConcurrent(changed, METADATA_CONCURRENCY, async ({ file, path }) => {
		const id = stableId(folder.id, path);
		const old = existingById.get(id);
		let info: { totalPages: number; thumbnailUrl: string } | undefined;
		try { info = await getPdfInfo(file); } catch (error) { console.warn('PDF metadata failed', path, error); }
		const composer = composerFromPath(path);
		const next: ScoreItem = {
			...(old || {}), id, title: file.name.replace(/\.pdf$/i, ''), composer,
			pdfBlob: file, thumbnailUrl: info?.thumbnailUrl || old?.thumbnailUrl,
			totalPages: info?.totalPages || old?.totalPages || 1, addedAt: old?.addedAt || Date.now(),
			lastOpenedAt: old?.lastOpenedAt || 0, favorite: old?.favorite || false, tags: old?.tags || [],
			collection: old?.collection || composer, sourceFolderId: folder.id, sourcePath: path,
			fileSize: file.size, fileModifiedAt: file.lastModified
		};
		return { next, existed: !!old };
	});

	await db.transaction('rw', db.scores, db.annotations, db.folders, async () => {
		for (const { next } of results) await db.scores.put(next);
		for (const old of existing) {
			if (!present.has(old.id)) {
				await db.scores.delete(old.id);
				await db.annotations.where('scoreId').equals(old.id).delete();
			}
		}
		await db.folders.put({ ...folder, lastSyncedAt: Date.now() });
	});

	return {
		added: results.filter((result) => !result.existed).length,
		updated: results.filter((result) => result.existed).length,
		removed: existing.filter((score) => !present.has(score.id)).length
	};
}

export async function syncAllFolders() {
	const folders = (await db.folders.toArray()).filter((folder) => folder.autoSync);
	const results: Array<{ added: number; updated: number; removed: number }> = [];
	let cursor = 0;
	async function worker() {
		while (cursor < folders.length) {
			const folder = folders[cursor++];
			try { results.push(await syncFolder(folder)); } catch (error) { console.warn('Folder sync failed', folder.name, error); }
		}
	}
	await Promise.all(Array.from({ length: Math.min(FOLDER_CONCURRENCY, folders.length) }, worker));
	return results;
}

export async function removeFolder(folder: FolderSource, removeScores = false) {
	if (removeScores) {
		const scores = await db.scores.where('sourceFolderId').equals(folder.id).toArray();
		await db.transaction('rw', db.scores, db.annotations, async () => {
			for (const score of scores) { await db.scores.delete(score.id); await db.annotations.where('scoreId').equals(score.id).delete(); }
		});
	}
	await db.folders.delete(folder.id);
}
