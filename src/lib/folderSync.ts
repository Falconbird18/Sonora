import { db } from './db';
import type { FolderSource, ScoreItem } from './types';
import { getPdfInfo } from './pdfUtils';

const PDF = '.pdf';
const ROOT_FOLDER_ID = 'library-root';
const METADATA_CONCURRENCY = 3;

export function supportsDirectoryAccess() {
	return typeof window !== 'undefined' && 'showDirectoryPicker' in window;
}

async function readPermission(handle: FileSystemDirectoryHandle) {
	const state = await handle.queryPermission({ mode: 'read' });
	if (state === 'granted') return true;
	return (await handle.requestPermission({ mode: 'read' })) === 'granted';
}

export async function verifyFolderPermission(folder: FolderSource) {
	return readPermission(folder.handle);
}

async function collectPdfs(
	handle: FileSystemDirectoryHandle,
	prefix = ''
): Promise<Array<{ file: File; path: string }>> {
	const result: Array<{ file: File; path: string }> = [];
	const directories: Array<{ handle: FileSystemDirectoryHandle; path: string }> = [];

	for await (const [name, entry] of handle.entries()) {
		if (name.startsWith('.') || name === 'node_modules') continue;
		const path = prefix ? `${prefix}/${name}` : name;
		if (entry.kind === 'file' && name.toLowerCase().endsWith(PDF)) {
			try {
				result.push({ file: await entry.getFile(), path });
			} catch (error) {
				console.warn('Could not read PDF', path, error);
			}
		} else if (entry.kind === 'directory') {
			directories.push({ handle: entry, path });
		}
	}

	for (const directory of directories) {
		result.push(...(await collectPdfs(directory.handle, directory.path)));
	}
	return result;
}

function composerFromPath(path: string) {
	const parts = path.split('/');
	return parts.length > 1 ? parts[parts.length - 2] : 'Unknown Composer';
}

function stableId(path: string) {
	return `${ROOT_FOLDER_ID}:${path}`;
}

async function mapConcurrent<T, R>(
	items: T[],
	limit: number,
	fn: (item: T) => Promise<R>
): Promise<R[]> {
	const results = new Array<R>(items.length);
	let cursor = 0;
	async function worker() {
		while (cursor < items.length) {
			const index = cursor++;
			try {
				results[index] = await fn(items[index]);
			} catch (error) {
				console.warn('Library item failed', error);
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
	return results.filter((result): result is R => result !== undefined);
}

async function removeOldRoots(keepId?: string) {
	const folders = await db.folders.toArray();
	for (const folder of folders) {
		if (folder.id === keepId) continue;
		const scores = await db.scores.where('sourceFolderId').equals(folder.id).toArray();
		await db.transaction('rw', db.scores, db.annotations, db.folders, async () => {
			for (const score of scores) {
				await db.scores.delete(score.id);
				await db.annotations.where('scoreId').equals(score.id).delete();
			}
			await db.folders.delete(folder.id);
		});
	}
}

export async function chooseAndAddFolder() {
	if (!supportsDirectoryAccess()) {
		throw new Error('Folder access is unavailable here. Use the folder chooser in the library to import the score folder.');
	}

	const handle = await window.showDirectoryPicker({ mode: 'read' });
	if (!(await readPermission(handle))) {
		throw new Error('Sonora was not granted access to the score folder.');
	}

	const existing = await db.folders.get(ROOT_FOLDER_ID);
	const folder: FolderSource = {
		id: ROOT_FOLDER_ID,
		name: handle.name,
		handle,
		addedAt: existing?.addedAt || Date.now(),
		lastSyncedAt: existing?.lastSyncedAt,
		autoSync: true
	};

	await removeOldRoots(ROOT_FOLDER_ID);
	await db.folders.put(folder);
	await syncFolder(folder);
	return folder;
}

export async function syncFolder(folder: FolderSource) {
	if (!(await verifyFolderPermission(folder))) {
		return { added: 0, updated: 0, removed: 0 };
	}

	const files = await collectPdfs(folder.handle);
	const existing = await db.scores.where('sourceFolderId').equals(folder.id).toArray();
	const existingById = new Map(existing.map((score) => [score.id, score]));
	const present = new Set(files.map(({ path }) => stableId(path)));
	const changed = files.filter(({ file, path }) => {
		const old = existingById.get(stableId(path));
		return !old || old.fileSize !== file.size || old.fileModifiedAt !== file.lastModified;
	});

	const results = await mapConcurrent(changed, METADATA_CONCURRENCY, async ({ file, path }) => {
		const id = stableId(path);
		const old = existingById.get(id);
		let info: { totalPages: number; thumbnailUrl: string } | undefined;
		try {
			info = await getPdfInfo(file);
		} catch (error) {
			console.warn('PDF metadata failed', path, error);
		}

		const next: ScoreItem = {
			...(old || {}),
			id,
			title: file.name.replace(/\.pdf$/i, ''),
			composer: old?.composer && old.composer !== 'Unknown Composer' ? old.composer : composerFromPath(path),
			pdfBlob: file,
			thumbnailUrl: info?.thumbnailUrl || old?.thumbnailUrl,
			totalPages: info?.totalPages || old?.totalPages || 1,
			addedAt: old?.addedAt || Date.now(),
			lastOpenedAt: old?.lastOpenedAt || 0,
			favorite: old?.favorite || false,
			tags: old?.tags || [],
			collection: old?.collection || 'Library',
			sourceFolderId: folder.id,
			sourcePath: path,
			fileSize: file.size,
			fileModifiedAt: file.lastModified
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
		await db.folders.put({ ...folder, id: ROOT_FOLDER_ID, lastSyncedAt: Date.now(), autoSync: true });
	});

	return {
		added: results.filter((result) => !result.existed).length,
		updated: results.filter((result) => result.existed).length,
		removed: existing.filter((score) => !present.has(score.id)).length
	};
}

export async function syncAllFolders() {
	const folder = await db.folders.get(ROOT_FOLDER_ID);
	if (!folder || !folder.autoSync) return [];
	return [await syncFolder(folder)];
}

export async function removeFolder(folder: FolderSource, removeScores = false) {
	if (removeScores) {
		const scores = await db.scores.where('sourceFolderId').equals(folder.id).toArray();
		await db.transaction('rw', db.scores, db.annotations, async () => {
			for (const score of scores) {
				await db.scores.delete(score.id);
				await db.annotations.where('scoreId').equals(score.id).delete();
			}
		});
	}
	await db.folders.delete(folder.id);
}
