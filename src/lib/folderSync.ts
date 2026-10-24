import { diskFolderId, parentPath } from './libraryFolderPaths';
import { reconcileDiskFolders } from './libraryFolders';
import { createMoveMatcher } from './fileIdentity';
import { invoke } from '@tauri-apps/api/core';
import { plainScore, migrateAnnotations } from './scoreMeta';
import { db } from './db';
import type { FolderSource, ScoreItem } from './types';
import { isTauri, joinNativePath, nativeFileUrl } from './paths';

const ROOT_FOLDER_ID = 'library-root';
const SYNC_INTERVAL_MS = 5 * 60 * 1000;

type NativeScoreFile = {
	path: string;
	relative_path: string;
	name: string;
	size: number;
	modified_at: number;
	metadata?: Partial<ScoreItem>;
};
type BrowserDirectoryHandle = FileSystemDirectoryHandle & {
	queryPermission(options: { mode: 'read' }): Promise<PermissionState>;
	requestPermission(options: { mode: 'read' }): Promise<PermissionState>;
};
type DirectoryPickerWindow = Window & {
	showDirectoryPicker(options: {
		mode: 'read';
	}): Promise<FileSystemDirectoryHandle>;
};

export function supportsDirectoryAccess() {
	return (
		isTauri() ||
		(typeof window !== 'undefined' && 'showDirectoryPicker' in window)
	);
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
			return await invoke<boolean>('score_folder_exists', {
				path: folder.nativePath
			});
		} catch {
			return false;
		}
	}
	return folder.handle ? verifyBrowserPermission(folder.handle) : false;
}

async function collectBrowserPdfs(
	handle: FileSystemDirectoryHandle,
	prefix = '',
	folderPaths: string[] = []
): Promise<Array<{ file: File; path: string }>> {
	const result: Array<{ file: File; path: string }> = [];
	const directories: Array<{
		handle: FileSystemDirectoryHandle;
		path: string;
	}> = [];
	for await (const [name, entry] of handle.entries()) {
		if (name.startsWith('.') || name === 'node_modules') continue;
		const path = prefix ? `${prefix}/${name}` : name;
		if (entry.kind === 'file' && name.toLowerCase().endsWith('.pdf')) {
			try {
				result.push({ file: await entry.getFile(), path });
			} catch (error) {
				throw new Error(`Could not read PDF ${path}: ${String(error)}`);
			}
		} else if (entry.kind === 'directory') {
			folderPaths.push(path);
			directories.push({ handle: entry, path });
		}
	}
	for (const directory of directories) {
		result.push(
			...(await collectBrowserPdfs(
				directory.handle,
				directory.path,
				folderPaths
			))
		);
	}
	return result;
}

function stableId(path: string) {
	return `${ROOT_FOLDER_ID}:${path}`;
}

function composerFromPath(path: string) {
	const parts = path.split(/[/\\]/);
	return parts.length > 1 ? parts[0] : 'Unknown Composer';
}

function plainFolder(folder: FolderSource): FolderSource {
	const out: FolderSource = {
		id: String(folder.id),
		name: String(folder.name ?? 'Score Library'),
		addedAt: Number(folder.addedAt) || Date.now(),
		autoSync: folder.autoSync !== false
	};
	if (folder.nativePath) out.nativePath = String(folder.nativePath);
	if (folder.lastSyncedAt != null)
		out.lastSyncedAt = Number(folder.lastSyncedAt);
	// FileSystemDirectoryHandle is structured-cloneable in Chromium when permission is granted
	if (folder.handle) out.handle = folder.handle;
	return out;
}

/** Copy user-edited metadata from an old row onto a newly detected path. */
function adoptMetadata(target: ScoreItem, source: ScoreItem): ScoreItem {
	return plainScore({
		...source,
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
		collection: source.collection,
		annotationLayers: source.annotationLayers,
		contentHash: source.contentHash
	});
}

async function removeOldRoots() {
	const folders = await db.folders.toArray();
	for (const folder of folders) {
		if (folder.id === ROOT_FOLDER_ID) continue;
		const scores = await db.scores
			.where('sourceFolderId')
			.equals(folder.id)
			.toArray();
		await db.transaction(
			'rw',
			db.scores,
			db.annotations,
			db.folders,
			async () => {
				for (const score of scores) {
					await db.scores.delete(score.id);
					await db.annotations.where('scoreId').equals(score.id).delete();
				}
				await db.folders.delete(folder.id);
			}
		);
	}
}

export async function chooseAndAddFolder() {
	if (!supportsDirectoryAccess())
		throw new Error('This environment does not support folder access.');
	let folder: FolderSource;
	const existing = await db.folders.get(ROOT_FOLDER_ID);
	if (isTauri()) {
		const path = await invoke<string | null>('pick_score_folder');
		if (!path)
			throw new DOMException('Folder selection cancelled', 'AbortError');
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
	let directories: string[];
	try {
		const tree = await invoke<{
			files: NativeScoreFile[];
			directories: string[];
		}>('list_score_tree', {
			path: folder.nativePath
		});
		files = tree.files;
		directories = tree.directories;
	} catch (error) {
		throw new Error(`Could not read the score folder: ${String(error)}`);
	}

	const existing = await db.scores
		.where('sourceFolderId')
		.equals(folder.id)
		.toArray();
	const existingById = new Map(existing.map((score) => [score.id, score]));
	const present = new Set(files.map((file) => stableId(file.relative_path)));
	const allowRemovals = true;

	const removed = existing.filter((score) => !present.has(score.id));
	const claimedRemovals = new Set<string>();
	const matchMove = createMoveMatcher(removed);

	let added = 0;
	let updated = 0;
	const toWrite: ScoreItem[] = [];
	const annotationMoves: Array<{ from: string; to: string }> = [];

	for (const file of files) {
		const id = stableId(file.relative_path);
		const old = existingById.get(id);
		const changed =
			!old ||
			old.fileSize !== file.size ||
			old.fileModifiedAt !== file.modified_at ||
			!old.nativePath ||
			(old.folderId ?? '') !== diskFolderId(parentPath(file.relative_path));
		if (!changed && old) continue;

		let next = plainScore({
			...old,
			id,
			title: old?.title ?? file.name.replace(/\.pdf$/i, ''),
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
			folderId: diskFolderId(parentPath(file.relative_path)),
			fileSize: file.size,
			fileModifiedAt: file.modified_at
		});

		if (!old) {
			const match = matchMove(file.size, file.modified_at);
			if (match) {
				claimedRemovals.add(match.id);
				next = adoptMetadata(next, match);
				annotationMoves.push({ from: match.id, to: id });
				updated++;
			} else {
				added++;
			}
		} else {
			if (
				old.fileSize !== file.size ||
				old.fileModifiedAt !== file.modified_at
			) {
				next.thumbnailUrl = undefined;
				next.totalPages = 1;
			}
			updated++;
		}

		if (!old && file.metadata) {
			const m = file.metadata;
			if (m.metadataEdited) next.metadataEdited = true;
			if (typeof m.year === 'number') next.year = m.year;
			if (typeof m.favorite === 'boolean') next.favorite = m.favorite;
			if (Array.isArray(m.tags))
				next.tags = m.tags.filter(
					(tag): tag is string => typeof tag === 'string'
				);
			// Paths, ids, and file identity always come from the scanner, never the sidecar.
			for (const key of [
				'title',
				'composer',
				'workId',
				'workTitle',
				'edition',
				'publisher',
				'editor',
				'arranger',
				'catalogue',
				'key',
				'compositionDate',
				'movements',
				'imslpPage',
				'instruments'
			] as const) {
				if (typeof m[key] === 'string') next[key] = m[key];
			}
		}
		toWrite.push(next);
	}

	await db.transaction(
		'rw',
		db.scores,
		db.annotations,
		db.lists,
		db.folders,
		async () => {
			if (toWrite.length) await db.scores.bulkPut(toWrite.map(plainScore));

			for (const move of annotationMoves) {
				await migrateAnnotations(move.from, move.to);
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
		}
	);

	await reconcileDiskFolders(directories);
	const trulyRemoved = allowRemovals
		? existing.filter(
				(score) => !present.has(score.id) && !claimedRemovals.has(score.id)
			).length
		: 0;
	return { added, updated, removed: trulyRemoved };
}

async function syncBrowserFolder(folder: FolderSource) {
	if (!folder.handle || !(await verifyBrowserPermission(folder.handle))) {
		return { added: 0, updated: 0, removed: 0 };
	}
	const directories: string[] = [];
	const files = await collectBrowserPdfs(folder.handle, '', directories);
	const existing = await db.scores
		.where('sourceFolderId')
		.equals(folder.id)
		.toArray();
	const existingById = new Map(existing.map((score) => [score.id, score]));
	const present = new Set(files.map(({ path }) => stableId(path)));
	const allowRemovals = true;

	const removed = existing.filter((score) => !present.has(score.id));
	const claimedRemovals = new Set<string>();
	const matchMove = createMoveMatcher(removed);

	const changed = files.filter(({ file, path }) => {
		const old = existingById.get(stableId(path));
		return (
			!old ||
			old.fileSize !== file.size ||
			old.fileModifiedAt !== file.lastModified ||
			!old.pdfBlob ||
			(old.folderId ?? '') !== diskFolderId(parentPath(path))
		);
	});

	// Publish file rows immediately; the visible-first thumbnail worker fills previews later.
	const results = changed.map(({ file, path }) => {
		const id = stableId(path);
		const old = existingById.get(id);
		const contentChanged =
			!!old &&
			(old.fileSize !== file.size || old.fileModifiedAt !== file.lastModified);

		// Prefer a plain Blob over the live File handle for IDB storage
		const blob =
			file instanceof Blob
				? file.slice(0, file.size, file.type || 'application/pdf')
				: undefined;

		let next = plainScore({
			...old,
			id,
			title: old?.title ?? file.name.replace(/\.pdf$/i, ''),
			composer:
				old?.composer && old.composer !== 'Unknown Composer'
					? old.composer
					: composerFromPath(path),
			pdfBlob: blob,
			thumbnailUrl: contentChanged ? undefined : old?.thumbnailUrl,
			thumbnailVersion: old?.thumbnailVersion,
			totalPages: contentChanged ? 1 : old?.totalPages || 1,
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
			folderId: diskFolderId(parentPath(path)),
			fileSize: file.size,
			fileModifiedAt: file.lastModified
		});

		let matchedFrom: string | undefined;
		if (!old) {
			const match = matchMove(file.size, file.lastModified);
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

	await db.transaction(
		'rw',
		db.scores,
		db.annotations,
		db.lists,
		db.folders,
		async () => {
			if (results.length)
				await db.scores.bulkPut(results.map(({ next }) => plainScore(next)));
			for (const { next, matchedFrom } of results) {
				if (matchedFrom) {
					await migrateAnnotations(matchedFrom, next.id);
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
		}
	);

	await reconcileDiskFolders(directories);
	return {
		added: results.filter((r) => !r.existed && !r.matchedFrom).length,
		updated: results.filter((r) => r.existed || r.matchedFrom).length,
		removed: allowRemovals
			? existing.filter((s) => !present.has(s.id) && !claimedRemovals.has(s.id))
					.length
			: 0
	};
}

export async function syncFolder(folder: FolderSource) {
	if (!folder.nativePath && !(await verifyFolderPermission(folder)))
		return { added: 0, updated: 0, removed: 0 };
	return folder.nativePath
		? syncNativeFolder(folder)
		: syncBrowserFolder(folder);
}

export async function syncAllFolders(force = false) {
	const folder = await db.folders.get(ROOT_FOLDER_ID);
	if (!folder || !folder.autoSync) return [];
	let needsPathBackfill = force;
	if (!needsPathBackfill && folder.nativePath) {
		try {
			const sample = await db.scores
				.where('sourceFolderId')
				.equals(folder.id)
				.limit(50)
				.toArray();
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
	if (score.pdfUrl?.length)
		return {
			url: score.pdfUrl,
			blob: score.pdfBlob,
			nativePath: score.nativePath
		};
	if (score.nativePath && isTauri()) {
		return {
			url: nativeFileUrl(score.nativePath),
			nativePath: score.nativePath,
			blob: score.pdfBlob
		};
	}
	if (isTauri() && score.sourcePath && folder?.nativePath) {
		const absolute = joinNativePath(folder.nativePath, score.sourcePath);
		return {
			url: nativeFileUrl(absolute),
			nativePath: absolute,
			blob: score.pdfBlob
		};
	}
	if (score.pdfBlob?.size)
		return { blob: score.pdfBlob, nativePath: score.nativePath };
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
		const scores = await db.scores
			.where('sourceFolderId')
			.equals(folder.id)
			.toArray();
		await db.transaction(
			'rw',
			db.scores,
			db.annotations,
			db.lists,
			async () => {
				for (const score of scores) {
					await db.scores.delete(score.id);
					await db.annotations.where('scoreId').equals(score.id).delete();
				}
			}
		);
	}
	await db.folders.delete(folder.id);
}
