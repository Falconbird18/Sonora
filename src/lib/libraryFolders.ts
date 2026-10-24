import { invoke } from '@tauri-apps/api/core';
import { db } from './db';
import { migrateAnnotations, plainScore } from './scoreMeta';
import { isTauri, joinNativePath } from './paths';
import {
	diskFolderId,
	foldersFromPaths,
	parentPath,
	validateFolderName
} from './libraryFolderPaths';
import type { FolderSource, ScoreItem } from './types';

/** Replace the folder index only when a completed filesystem scan changes it. */
export async function reconcileDiskFolders(directories: string[]) {
	const next = foldersFromPaths(directories);
	const previous = await db.libraryFolders.toArray();
	const old = new Map(previous.map((f) => [f.id, f]));
	const nextIds = new Set(next.map((f) => f.id));
	const removed = previous.filter((f) => !nextIds.has(f.id)).map((f) => f.id);
	const changed = next.filter(
		(f) =>
			old.get(f.id)?.sourcePath !== f.sourcePath ||
			old.get(f.id)?.name !== f.name ||
			old.get(f.id)?.parentId !== f.parentId
	);
	if (removed.length || changed.length)
		await db.transaction('rw', db.libraryFolders, async () => {
			if (removed.length) await db.libraryFolders.bulkDelete(removed);
			if (changed.length) await db.libraryFolders.bulkPut(changed);
		});
}
export async function createDiskFolder(
	root: FolderSource,
	parent: string,
	name: string
) {
	const segment = validateFolderName(name);
	const path = parent ? `${parent}/${segment}` : segment;
	if (root.nativePath && isTauri()) {
		await invoke('create_score_directory', {
			libraryRoot: root.nativePath,
			relativePath: path
		});
	} else if (root.handle) {
		const handle = root.handle as FileSystemDirectoryHandle & {
			requestPermission(options: {
				mode: 'readwrite';
			}): Promise<PermissionState>;
		};
		if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted')
			throw Error('Folder access was not granted.');
		let directory: FileSystemDirectoryHandle = handle;
		for (const part of parent.split('/').filter(Boolean))
			directory = await directory.getDirectoryHandle(part);
		try {
			await directory.getDirectoryHandle(segment);
			throw Error('A folder with that name already exists.');
		} catch (error) {
			if (!(error instanceof DOMException) || error.name !== 'NotFoundError')
				throw error;
		}
		await directory.getDirectoryHandle(segment, { create: true });
	} else throw Error('Connect a score folder before organizing files.');
	return path;
}

/** Explicit moves preserve identity, annotations and program entries without file-size guessing. */
export async function moveDiskEntry(
	root: FolderSource,
	source: string,
	destination: string,
	directory: boolean
) {
	if (!root.nativePath || !isTauri())
		throw Error('Moving files is available in the Sonora desktop app.');
	if (source === destination) return;
	if (directory && destination.startsWith(`${source}/`))
		throw Error('A folder cannot be moved inside itself.');
	const affected = (
		await db.scores.where('sourceFolderId').equals(root.id).toArray()
	).filter((score) =>
		directory
			? score.sourcePath?.startsWith(`${source}/`)
			: score.sourcePath === source
	);
	await invoke('move_score_entry', {
		libraryRoot: root.nativePath,
		sourceRelative: source,
		destinationRelative: destination
	});
	try {
		await db.transaction(
			'rw',
			db.scores,
			db.annotations,
			db.lists,
			async () => {
				for (const score of affected) {
					const path = directory
						? destination + score.sourcePath!.slice(source.length)
						: destination;
					const id = `${root.id}:${path}`;
					const next: ScoreItem = plainScore({
						...score,
						id,
						sourcePath: path,
						nativePath: joinNativePath(root.nativePath!, path),
						pdfUrl: undefined,
						folderId: diskFolderId(parentPath(path))
					});
					await migrateAnnotations(score.id, id);
					await db.scores.delete(score.id);
					await db.scores.put(next);
				}
			}
		);
	} catch (error) {
		// Keep disk and catalogue consistent if IDB cannot commit the new identities.
		try {
			await invoke('move_score_entry', {
				libraryRoot: root.nativePath,
				sourceRelative: destination,
				destinationRelative: source
			});
		} catch {
			throw Error(
				'The file moved, but the catalogue could not update. Refresh the library.'
			);
		}
		throw error;
	}
}

/** Called only after the user confirms permanent deletion of the entire directory. */
export async function deleteDiskFolder(root: FolderSource, path: string) {
	if (!path) throw Error('The library root cannot be deleted.');
	const affected = (
		await db.scores.where('sourceFolderId').equals(root.id).toArray()
	).filter((score) => score.sourcePath?.startsWith(`${path}/`));
	if (root.nativePath && isTauri()) {
		await invoke('delete_score_directory', {
			libraryRoot: root.nativePath,
			relativePath: path
		});
	} else if (root.handle) {
		const handle = root.handle as FileSystemDirectoryHandle & {
			requestPermission(options: {
				mode: 'readwrite';
			}): Promise<PermissionState>;
		};
		if ((await handle.requestPermission({ mode: 'readwrite' })) !== 'granted')
			throw Error('Folder access was not granted.');
		const parts = path.split('/');
		let parent: FileSystemDirectoryHandle = handle;
		for (const part of parts.slice(0, -1))
			parent = await parent.getDirectoryHandle(part);
		await parent.removeEntry(parts.at(-1)!, { recursive: true });
	} else throw Error('Connect a score folder before deleting folders.');
	const ids = new Set(affected.map((score) => score.id));
	await db.transaction(
		'rw',
		db.scores,
		db.annotations,
		db.lists,
		db.libraryFolders,
		async () => {
			for (const id of ids)
				await db.annotations.where('scoreId').equals(id).delete();
			await db.lists.toCollection().modify((list) => {
				list.entries = list.entries.filter((entry) => !ids.has(entry.scoreId));
			});
			await db.scores.bulkDelete([...ids]);
			const folders = await db.libraryFolders.toArray();
			await db.libraryFolders.bulkDelete(
				folders
					.filter(
						(f) => f.sourcePath === path || f.sourcePath?.startsWith(`${path}/`)
					)
					.map((f) => f.id)
			);
		}
	);
}
