import { invoke } from '@tauri-apps/api/core';
import { db } from './db';
import type { FolderSource, ScoreItem } from './types';
import { getPdfInfoFromSource } from './pdfUtils';
import { isTauri, joinNativePath, nativeFileUrl } from './paths';

const ROOT_FOLDER_ID = 'library-root';
const METADATA_CONCURRENCY = 2;
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

type NativeScoreFile = {
	path: string;
	relative_path: string;
	name: string;
	size: number;
	modified_at: number;
};
type BrowserDirectoryHandle = FileSystemDirectoryHandle & {
	queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
	requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
};
type DirectoryPickerWindow = Window & {
	showDirectoryPicker(options: { mode: 'read' }): Promise<FileSystemDirectoryHandle>;
};

export function supportsDirectoryAccess() {
	return isTauri() || (typeof window !== 'undefined' && 'showDirectoryPicker' in window);
}

async function verifyBrowserPermission(handle: FileSystemDirectoryHandle) {
	const fsHandle = handle as BrowserDirectoryHandle;
	const state = await fsHandle.queryPermission({ mode: 'read' });
	if (state === 'granted') return true;
	return (await fsHandle.requestPermission({ mode: 'read' })) === 'granted';
}

export async function verifyFolderPermission(folder: FolderSource) {
	if (folder.nativePath) {
		try {
			await invoke<NativeScoreFile[]>('list_score_files', { path: folder.nativePath });
			return true;
		} catch {
			return false;
		}
	}
	return folder.handle ? verifyBrowserPermission(folder.handle) : false;
}

async function collectBrowserPdfs(
	handle: FileSystemDirectoryHandle,
	prefix = ''
): Promise<Array<{ file: File; path: string }>> {
	const result: Array<{ file: File; path: string }> = [];
	const directories: Array<{ handle: FileSystemDirectoryHandle; path: string }> = [];
	for await (const [name, entry] of handle.entries()) {
		if (name.startsWith('.') || name === 'node_modules') continue;
		const path = prefix ? `${prefix}/${name}` : name;
		if (entry.kind === 'file' && name.toLowerCase().endsWith('.pdf')) {
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
		result.push(...(await collectBrowserPdfs(directory.handle, directory.path)));
	}
	return result;
}

async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
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

function stableId(path: string) {
	return `${ROOT_FOLDER_ID}:${path}`;
}

function composerFromPath(path: string) {
	const parts = path.split(/[/\\]/);
	return parts.length > 1 ? parts[parts.length - 2] : 'Unknown Composer';
}

/** Strip to structured-cloneable fields only (no Svelte proxies / extra junk). */
function plainScore(input: ScoreItem): ScoreItem {
	const out: ScoreItem = {
		id: String(input.id),
		title: String(input.title ?? ''),
		composer: String(input.composer ?? 'Unknown Composer'),
		totalPages: Number(input.totalPages) || 1,
		addedAt: Number(input.addedAt) || Date.now()
	};
	if (input.year != null && !Number.isNaN(Number(input.year))) out.year = Number(input.year);
	else out.year = null;
	if (input.ensemble) out.ensemble = String(input.ensemble);
	if (input.instruments) out.instruments = String(input.instruments);
	if (input.pdfUrl) out.pdfUrl = String(input.pdfUrl);
	if (input.thumbnailUrl) out.thumbnailUrl = String(input.thumbnailUrl);
	if (input.thumbnailVersion != null) out.thumbnailVersion = Number(input.thumbnailVersion);
	if (input.lastOpenedAt != null) out.lastOpenedAt = Number(input.lastOpenedAt);
	out.favorite = !!input.favorite;
	out.tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
	if (input.collection) out.collection = String(input.collection);
	if (input.sourceFolderId) out.sourceFolderId = String(input.sourceFolderId);
	if (input.sourcePath) out.sourcePath = String(input.sourcePath);
	if (input.nativePath) out.nativePath = String(input.nativePath);
	if (input.fileSize != null) out.fileSize = Number(input.fileSize);
	if (input.fileModifiedAt != null) out.fileModifiedAt = Number(input.fileModifiedAt);
	// Only persist real Blob/File instances — never proxies or odd objects
	if (typeof Blob !== 'undefined' && input.pdfBlob instanceof Blob && input.pdfBlob.size > 0) {
		out.pdfBlob = input.pdfBlob;
	}
	return out;
}

function plainFolder(folder: FolderSource): FolderSource {
	const out: FolderSource = {
		id: String(folder.id),
		name: String(folder.name ?? 'Score Library'),
		addedAt: Number(folder.addedAt) || Date.now(),
		autoSync: folder.autoSync !== false
	};
	if (folder.nativePath) out.nativePath = String(folder.nativePath);
	if (folder.lastSyncedAt != null) out.lastSyncedAt = Number(folder.lastSyncedAt);
	// FileSystemDirectoryHandle is structured-cloneable in Chromium when permission is granted
	if (folder.handle) out.handle = folder.handle;
	return out;
}

/** Copy user-edited metadata from an old row onto a newly detected path. */
function adoptMetadata(target: ScoreItem, source: ScoreItem): ScoreItem {
	return plainScore({
		...target,
		title: source.title,
		composer: source.composer,
		year: source.year,
		ensemble: source.ensemble,
		instruments: source.instruments,
		tags: source.tags,
		favorite: source.favorite,
		lastOpenedAt: source.lastOpenedAt,
		thumbnailUrl: source.thumbnailUrl,
		thumbnailVersion: source.thumbnailVersion,
		totalPages: source.totalPages || target.totalPages,
		addedAt: source.addedAt,
		collection: source.collection
	});
}

async function removeOldRoots() {
	const folders = await db.folders.toArray();
	for (const folder of folders) {
		if (folder.id === ROOT_FOLDER_ID) continue;
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
	if (!supportsDirectoryAccess()) throw new Error('This environment does not support folder access.');
	let folder: FolderSource;
	const existing = await db.folders.get(ROOT_FOLDER_ID);
	if (isTauri()) {
		const path = await invoke<string | null>('pick_score_folder');
		if (!path) throw new DOMException('Folder selection cancelled', 'AbortError');
		folder = {
			id: ROOT_FOLDER_ID,
			name: path.split(/[\\/]/).filter(Boolean).pop() || 'Score Library',
			nativePath: path,
			addedAt: existing?.addedAt || Date.now(),
			lastSyncedAt: existing?.lastSyncedAt,
			autoSync: true
		};
	} else {
		const pickerWindow = window as unknown as DirectoryPickerWindow;
		const handle = await pickerWindow.showDirectoryPicker({ mode: 'read' });
		if (!(await verifyBrowserPermission(handle))) {
			throw new Error('Sonora was not granted access to the score folder.');
		}
		folder = {
			id: ROOT_FOLDER_ID,
			name: handle.name,
			handle,
			addedAt: existing?.addedAt || Date.now(),
			lastSyncedAt: existing?.lastSyncedAt,
			autoSync: true
		};
	}
	await removeOldRoots();
	await db.folders.put(plainFolder(folder));
	await syncFolder(folder);
	return folder;
}

async function syncNativeFolder(folder: FolderSource) {
	if (!folder.nativePath) return { added: 0, updated: 0, removed: 0 };
	let files: NativeScoreFile[];
	try {
		files = await invoke<NativeScoreFile[]>('list_score_files', { path: folder.nativePath });
	} catch (error) {
		console.warn('list_score_files failed', error);
		return { added: 0, updated: 0, removed: 0 };
	}

	const existing = await db.scores.where('sourceFolderId').equals(folder.id).toArray();
	const existingById = new Map(existing.map((score) => [score.id, score]));
	const present = new Set(files.map((file) => stableId(file.relative_path)));
	const allowRemovals = files.length > 0 || existing.length === 0;

	const removed = existing.filter((score) => !present.has(score.id));
	const claimedRemovals = new Set<string>();

	let added = 0;
	let updated = 0;
	const toWrite: ScoreItem[] = [];
	const annotationMoves: Array<{ from: string; to: string }> = [];

	for (const file of files) {
		const id = stableId(file.relative_path);
		const old = existingById.get(id);
		const changed =
			!old || old.fileSize !== file.size || old.fileModifiedAt !== file.modified_at || !old.nativePath;
		if (!changed && old) continue;

		let next = plainScore({
			id,
			title: file.name.replace(/\.pdf$/i, ''),
			composer:
				old?.composer && old.composer !== 'Unknown Composer'
					? old.composer
					: composerFromPath(file.relative_path),
			nativePath: file.path,
			thumbnailUrl: old?.thumbnailUrl,
			thumbnailVersion: old?.thumbnailVersion,
			totalPages: old?.totalPages || 1,
			addedAt: old?.addedAt || Date.now(),
			lastOpenedAt: old?.lastOpenedAt || 0,
			favorite: old?.favorite || false,
			tags: old?.tags || [],
			year: old?.year ?? null,
			ensemble: old?.ensemble,
			instruments: old?.instruments,
			collection: old?.collection || 'Library',
			sourceFolderId: folder.id,
			sourcePath: file.relative_path,
			fileSize: file.size,
			fileModifiedAt: file.modified_at
		});

		if (!old) {
			const match = removed.find(
				(r) =>
					!claimedRemovals.has(r.id) &&
					r.fileSize === file.size &&
					r.fileModifiedAt === file.modified_at
			);
			if (match) {
				claimedRemovals.add(match.id);
				next = adoptMetadata(next, match);
				annotationMoves.push({ from: match.id, to: id });
				updated++;
			} else {
				added++;
			}
		} else {
			if (old.fileSize !== file.size || old.fileModifiedAt !== file.modified_at) {
				next.thumbnailUrl = undefined;
				next.totalPages = 1;
			}
			updated++;
		}

		toWrite.push(next);
	}

	await db.transaction('rw', db.scores, db.annotations, db.folders, async () => {
		for (const next of toWrite) await db.scores.put(plainScore(next));

		for (const move of annotationMoves) {
			await db.annotations.where('scoreId').equals(move.from).modify({ scoreId: move.to });
			await db.scores.delete(move.from);
		}

		if (allowRemovals) {
			for (const old of existing) {
				if (!present.has(old.id) && !claimedRemovals.has(old.id)) {
					await db.scores.delete(old.id);
					await db.annotations.where('scoreId').equals(old.id).delete();
				}
			}
		}

		await db.folders.put(
			plainFolder({ ...folder, lastSyncedAt: Date.now(), autoSync: true })
		);
	});

	const trulyRemoved = allowRemovals
		? existing.filter((score) => !present.has(score.id) && !claimedRemovals.has(score.id)).length
		: 0;
	return { added, updated, removed: trulyRemoved };
}

async function syncBrowserFolder(folder: FolderSource) {
	if (!folder.handle || !(await verifyBrowserPermission(folder.handle))) {
		return { added: 0, updated: 0, removed: 0 };
	}
	const files = await collectBrowserPdfs(folder.handle);
	const existing = await db.scores.where('sourceFolderId').equals(folder.id).toArray();
	const existingById = new Map(existing.map((score) => [score.id, score]));
	const present = new Set(files.map(({ path }) => stableId(path)));
	const allowRemovals = files.length > 0 || existing.length === 0;

	const removed = existing.filter((score) => !present.has(score.id));
	const claimedRemovals = new Set<string>();

	const changed = files.filter(({ file, path }) => {
		const old = existingById.get(stableId(path));
		return (
			!old ||
			old.fileSize !== file.size ||
			old.fileModifiedAt !== file.lastModified ||
			!old.thumbnailUrl
		);
	});

	const results = await mapConcurrent(changed, METADATA_CONCURRENCY, async ({ file, path }) => {
		const id = stableId(path);
		const old = existingById.get(id);
		let info: { totalPages: number; thumbnailUrl?: string } | undefined;
		try {
			info = await getPdfInfoFromSource({ blob: file });
		} catch (error) {
			console.warn('PDF metadata failed', path, error);
		}

		// Prefer a plain Blob over the live File handle for IDB storage
		const blob =
			file instanceof Blob ? file.slice(0, file.size, file.type || 'application/pdf') : undefined;

		let next = plainScore({
			id,
			title: file.name.replace(/\.pdf$/i, ''),
			composer:
				old?.composer && old.composer !== 'Unknown Composer'
					? old.composer
					: composerFromPath(path),
			pdfBlob: blob,
			thumbnailUrl: info?.thumbnailUrl || old?.thumbnailUrl,
			thumbnailVersion: old?.thumbnailVersion,
			totalPages: info?.totalPages || old?.totalPages || 1,
			addedAt: old?.addedAt || Date.now(),
			lastOpenedAt: old?.lastOpenedAt || 0,
			favorite: old?.favorite || false,
			tags: old?.tags || [],
			year: old?.year ?? null,
			ensemble: old?.ensemble,
			instruments: old?.instruments,
			collection: old?.collection || 'Library',
			sourceFolderId: folder.id,
			sourcePath: path,
			fileSize: file.size,
			fileModifiedAt: file.lastModified
		});

		let matchedFrom: string | undefined;
		if (!old) {
			const match = removed.find(
				(r) =>
					!claimedRemovals.has(r.id) &&
					r.fileSize === file.size &&
					r.fileModifiedAt === file.lastModified
			);
			if (match) {
				claimedRemovals.add(match.id);
				next = adoptMetadata(next, match);
				// Keep the fresh blob after metadata adopt
				if (blob) next.pdfBlob = blob;
				matchedFrom = match.id;
			}
		}

		return { next, existed: !!old, matchedFrom };
	});

	await db.transaction('rw', db.scores, db.annotations, db.folders, async () => {
		for (const { next, matchedFrom } of results) {
			await db.scores.put(plainScore(next));
			if (matchedFrom) {
				await db.annotations.where('scoreId').equals(matchedFrom).modify({ scoreId: next.id });
				await db.scores.delete(matchedFrom);
			}
		}

		if (allowRemovals) {
			for (const old of existing) {
				if (!present.has(old.id) && !claimedRemovals.has(old.id)) {
					await db.scores.delete(old.id);
					await db.annotations.where('scoreId').equals(old.id).delete();
				}
			}
		}

		await db.folders.put(
			plainFolder({ ...folder, lastSyncedAt: Date.now(), autoSync: true })
		);
	});

	return {
		added: results.filter((r) => !r.existed && !r.matchedFrom).length,
		updated: results.filter((r) => r.existed || r.matchedFrom).length,
		removed: allowRemovals
			? existing.filter((s) => !present.has(s.id) && !claimedRemovals.has(s.id)).length
			: 0
	};
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
		} catch {
			needsPathBackfill = true;
		}
	}
	if (
		!force &&
		!needsPathBackfill &&
		folder.lastSyncedAt &&
		Date.now() - folder.lastSyncedAt < SYNC_INTERVAL_MS
	) {
		return [{ added: 0, updated: 0, removed: 0, skipped: true as const }];
	}
	return [await syncFolder(folder)];
}

export function resolveScoreSource(
	score: ScoreItem,
	folder?: FolderSource
): { url?: string; blob?: Blob; nativePath?: string } {
	if (score.pdfUrl?.length) return { url: score.pdfUrl, blob: score.pdfBlob, nativePath: score.nativePath };
	if (score.nativePath && isTauri()) {
		return { url: nativeFileUrl(score.nativePath), nativePath: score.nativePath, blob: score.pdfBlob };
	}
	if (isTauri() && score.sourcePath && folder?.nativePath) {
		const absolute = joinNativePath(folder.nativePath, score.sourcePath);
		return { url: nativeFileUrl(absolute), nativePath: absolute, blob: score.pdfBlob };
	}
	if (score.pdfBlob?.size) return { blob: score.pdfBlob, nativePath: score.nativePath };
	return {};
}

export async function resolveScoreSourceAsync(score: ScoreItem) {
	let folder: FolderSource | undefined;
	try {
		folder = await db.folders.get(ROOT_FOLDER_ID);
	} catch (err) {
		console.warn('Could not load library folder', err);
	}
	return resolveScoreSource(score, folder);
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
