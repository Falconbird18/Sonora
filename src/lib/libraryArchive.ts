import { invoke } from '@tauri-apps/api/core';
import { db } from './db';
import {
	foldersFromPaths,
	parentPath,
	diskFolderId
} from './libraryFolderPaths';
import { flushAnnotationSaves } from './annotationStore';
import { plainScore } from './scoreMeta';
import { joinNativePath } from './paths';
import type {
	ScoreItem,
	AnnotationRecord,
	ScoreList,
	LibraryFolder
} from './types';

export type ArchiveScore = Omit<
	ScoreItem,
	| 'pdfBlob'
	| 'pdfUrl'
	| 'nativePath'
	| 'thumbnailUrl'
	| 'sourcePath'
	| 'sourceFolderId'
> & { pdf: string };
export interface LibraryManifest {
	format: 'sonora-library';
	version: 1;
	exportedAt: string;
	scores: ArchiveScore[];
	annotations: AnnotationRecord[];
	lists: ScoreList[];
	folders?: LibraryFolder[];
}
export type ImportedFile = {
	source_id: string;
	native_path: string;
	relative_path: string;
	size: number;
	modified_at: number;
};
function record(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value);
}
export function validateManifest(
	input: unknown
): asserts input is LibraryManifest {
	if (
		!record(input) ||
		input.format !== 'sonora-library' ||
		input.version !== 1 ||
		!Array.isArray(input.scores) ||
		!Array.isArray(input.annotations) ||
		!Array.isArray(input.lists)
	)
		throw new Error('Unsupported Sonora library archive.');
	if (input.folders !== undefined) {
		if (!Array.isArray(input.folders)) throw Error('Invalid folders.');
		const parents = new Map<string, string>();
		for (const folder of input.folders) {
			if (
				!record(folder) ||
				typeof folder.id !== 'string' ||
				!folder.id ||
				typeof folder.name !== 'string' ||
				typeof folder.parentId !== 'string' ||
				parents.has(folder.id)
			)
				throw Error('Invalid folder.');
			parents.set(folder.id, folder.parentId);
		}
		for (const id of parents.keys()) {
			const seen = new Set<string>();
			let current = id;
			while (current) {
				if (seen.has(current) || !parents.has(current))
					throw Error('Invalid folder hierarchy.');
				seen.add(current);
				current = parents.get(current)!;
			}
		}
	}
	const ids = new Set<string>();
	for (const score of input.scores) {
		if (
			!record(score) ||
			typeof score.id !== 'string' ||
			typeof score.title !== 'string' ||
			typeof score.composer !== 'string' ||
			typeof score.pdf !== 'string' ||
			ids.has(score.id)
		)
			throw new Error('Invalid score catalogue.');
		ids.add(score.id);
	}
	for (const row of input.annotations) {
		if (
			!record(row) ||
			typeof row.scoreId !== 'string' ||
			!Number.isSafeInteger(row.pageNum) ||
			Number(row.pageNum) < 1 ||
			!Array.isArray(row.strokes) ||
			!Array.isArray(row.stamps) ||
			!Array.isArray(row.notes)
		)
			throw new Error('Invalid annotation record.');
		for (const stroke of row.strokes) {
			if (
				!record(stroke) ||
				!['pen', 'highlighter'].includes(String(stroke.tool)) ||
				!Number.isFinite(stroke.width) ||
				typeof stroke.color !== 'string' ||
				!Array.isArray(stroke.points) ||
				stroke.points.some(
					(point) =>
						!record(point) ||
						!Number.isFinite(point.x) ||
						!Number.isFinite(point.y)
				)
			)
				throw new Error('Invalid pen annotation.');
		}
		for (const item of [...row.stamps, ...row.notes]) {
			if (
				!record(item) ||
				typeof item.id !== 'string' ||
				!Number.isFinite(item.x) ||
				!Number.isFinite(item.y) ||
				!Number.isFinite(item.fontSize) ||
				typeof item.color !== 'string' ||
				!(typeof item.text === 'string' || typeof item.symbol === 'string')
			)
				throw new Error('Invalid text or symbol annotation.');
		}
	}
	for (const list of input.lists) {
		if (
			!record(list) ||
			typeof list.id !== 'string' ||
			typeof list.name !== 'string' ||
			!Array.isArray(list.entries) ||
			list.entries.some(
				(entry) =>
					!record(entry) ||
					typeof entry.id !== 'string' ||
					typeof entry.scoreId !== 'string'
			)
		)
			throw new Error('Invalid ordered list.');
	}
}
export function portableScore(score: ScoreItem, index: number): ArchiveScore {
	const {
		pdfBlob,
		pdfUrl,
		nativePath,
		thumbnailUrl,
		thumbnailVersion,
		sourcePath,
		sourceFolderId,
		...metadata
	} = plainScore(score);
	return { ...metadata, pdf: `scores/${String(index).padStart(6, '0')}.pdf` };
}
async function encodeBlob(blob: Blob) {
	const bytes = new Uint8Array(await blob.arrayBuffer());
	let binary = '';
	for (let i = 0; i < bytes.length; i += 32768)
		binary += String.fromCharCode(...bytes.subarray(i, i + 32768));
	return btoa(binary);
}
export async function exportCompleteLibrary(): Promise<string | null> {
	await flushAnnotationSaves();
	const snapshot = await db.transaction(
		'r',
		db.scores,
		db.annotations,
		db.lists,
		db.libraryFolders,
		async () => ({
			scores: await db.scores.toArray(),
			annotations: await db.annotations.toArray(),
			lists: await db.lists.toArray(),
			folders: await db.libraryFolders.toArray()
		})
	);
	const folder = await db.folders.get('library-root');
	const validIds = new Set(snapshot.scores.map((score) => score.id));
	const manifest: LibraryManifest = {
		format: 'sonora-library',
		version: 1,
		exportedAt: new Date().toISOString(),
		scores: snapshot.scores.map(portableScore),
		annotations: snapshot.annotations.filter((row) =>
			validIds.has(row.scoreId)
		),
		lists: snapshot.lists,
		folders: snapshot.folders
	};
	validateManifest(manifest);
	const sources = await Promise.all(
		snapshot.scores.map(async (score) => ({
			score_id: score.id,
			path:
				score.nativePath ||
				(folder?.nativePath && score.sourcePath
					? joinNativePath(folder.nativePath, score.sourcePath)
					: null),
			bytes_base64: score.pdfBlob ? await encodeBlob(score.pdfBlob) : null
		}))
	);
	return invoke<string | null>('export_library_archive', {
		manifest,
		sources,
		libraryRoot: folder?.nativePath ?? null
	});
}
export function remapLibrary(manifest: LibraryManifest, files: ImportedFile[]) {
	validateManifest(manifest);
	const bySource = new Map(files.map((file) => [file.source_id, file]));
	if (bySource.size !== manifest.scores.length)
		throw new Error('Archive PDF count does not match its catalogue.');
	const ids = new Map(
		files.map((file) => [file.source_id, `library-root:${file.relative_path}`])
	);
	const folders = foldersFromPaths(
		files.map((file) => parentPath(file.relative_path))
	);
	const scores = manifest.scores.map((score) => {
		const file = bySource.get(score.id);
		if (!file) throw new Error(`Missing PDF for ${score.title}`);
		return plainScore({
			...score,
			folderId: diskFolderId(parentPath(file.relative_path)),
			id: ids.get(score.id)!,
			sourceFolderId: 'library-root',
			sourcePath: file.relative_path,
			nativePath: file.native_path,
			fileSize: file.size,
			fileModifiedAt: file.modified_at,
			metadataEdited: true
		});
	});
	const annotations = manifest.annotations
		.filter((row) => ids.has(row.scoreId))
		.map((row) => {
			const scoreId = ids.get(row.scoreId)!;
			return {
				...row,
				id: `${scoreId}:${row.pageNum}`,
				scoreId,
				stamps: row.stamps.map((item) => ({ ...item, scoreId })),
				notes: row.notes.map((item) => ({ ...item, scoreId }))
			};
		});
	const now = Date.now();
	const lists = manifest.lists.map((list) => ({
		...list,
		id: crypto.randomUUID(),
		description: list.description || '',
		createdAt: list.createdAt || now,
		updatedAt: now,
		entries: list.entries.map((entry) => ({
			id: crypto.randomUUID(),
			scoreId: ids.get(entry.scoreId) || `missing:${entry.scoreId}`
		}))
	}));
	return { scores, annotations, lists, folders };
}
export async function importLibrary(
	libraryRoot: string
): Promise<{ scores: number; lists: number } | null> {
	const result = await invoke<{
		manifest: LibraryManifest;
		files: ImportedFile[];
	} | null>('import_library_archive', { libraryRoot });
	if (!result) return null;
	const restored = remapLibrary(result.manifest, result.files);
	await db.transaction(
		'rw',
		db.scores,
		db.annotations,
		db.lists,
		db.libraryFolders,
		async () => {
			await db.scores.bulkPut(restored.scores);
			await db.annotations.bulkPut(restored.annotations);
			await db.lists.bulkPut(restored.lists);
			await db.libraryFolders.bulkPut(restored.folders);
		}
	);
	return { scores: restored.scores.length, lists: restored.lists.length };
}
