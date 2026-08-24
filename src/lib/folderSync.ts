import { db } from './db';
import type { FolderSource, ScoreItem } from './types';
import { getPdfInfo } from './pdfUtils';

const PDF = '.pdf';

export async function chooseAndAddFolder() {
	if (!('showDirectoryPicker' in window)) throw new Error('Folder synchronization requires a browser with the File System Access API.');
	const handle = await window.showDirectoryPicker({ mode: 'read' });
	const permission = await handle.requestPermission({ mode: 'read' });
	if (permission !== 'granted') throw new Error('Sonora was not granted access to this folder.');
	const folder: FolderSource = {
		id: crypto.randomUUID(), name: handle.name, handle, addedAt: Date.now(), autoSync: true
	};
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
	for await (const [name, entry] of handle.entries()) {
		const path = prefix ? `${prefix}/${name}` : name;
		if (entry.kind === 'file' && name.toLowerCase().endsWith(PDF)) result.push({ file: await entry.getFile(), path });
		else if (entry.kind === 'directory') result.push(...await collectPdfs(entry, path));
	}
	return result;
}

function composerFromPath(path: string) {
	const parts = path.split('/');
	return parts.length > 1 ? parts[parts.length - 2] : 'Unknown Composer';
}

function stableId(folderId: string, path: string) {
	return `${folderId}:${path}`;
}

export async function syncFolder(folder: FolderSource) {
	if (!(await verifyFolderPermission(folder))) return { added: 0, updated: 0, removed: 0 };
	const files = await collectPdfs(folder.handle);
	const existing = await db.scores.where('sourceFolderId').equals(folder.id).toArray();
	const present = new Set<string>();
	let added = 0;
	let updated = 0;

	for (const { file, path } of files) {
		const id = stableId(folder.id, path);
		present.add(id);
		const old = await db.scores.get(id);
		if (old && old.fileSize === file.size && old.fileModifiedAt === file.lastModified) continue;
		let info: { totalPages: number; thumbnailUrl: string } | undefined;
		try { info = await getPdfInfo(file); } catch (error) { console.warn('PDF metadata failed', path, error); }
		const next: ScoreItem = {
			...(old || {}),
			id, title: file.name.replace(/\.pdf$/i, ''), composer: composerFromPath(path),
			pdfBlob: file, thumbnailUrl: info?.thumbnailUrl || old?.thumbnailUrl,
			totalPages: info?.totalPages || old?.totalPages || 1, addedAt: old?.addedAt || Date.now(),
			lastOpenedAt: old?.lastOpenedAt || 0, favorite: old?.favorite || false, tags: old?.tags || [],
			collection: old?.collection || composerFromPath(path), sourceFolderId: folder.id,
			sourcePath: path, fileSize: file.size, fileModifiedAt: file.lastModified
		};
		await db.scores.put(next);
		if (old) updated++; else added++;
	}

	for (const old of existing) {
		if (!present.has(old.id)) {
			await db.scores.delete(old.id);
			await db.annotations.where('scoreId').equals(old.id).delete();
		}
	}
	await db.folders.put({ ...folder, lastSyncedAt: Date.now() });
	return { added, updated, removed: existing.length - present.size };
}

export async function syncAllFolders() {
	const folders = await db.folders.toArray();
	const results = [];
	for (const folder of folders) {
		if (folder.autoSync) results.push(await syncFolder(folder));
	}
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
