import { invoke } from '@tauri-apps/api/core';
import { get } from 'svelte/store';
import { db } from './db';
import { findComposer } from './composerDatabase';
import { isTauri } from './paths';
import { settings } from './settingsStore';
import type { ScoreItem, ScoreMetadataUpdate } from './types';

const ROOT_FOLDER_ID = 'library-root';

export function plainScore(input: ScoreItem): ScoreItem {
	const out: ScoreItem = {
		id: String(input.id),
		title: String(input.title ?? ''),
		composer: String(input.composer ?? 'Unknown Composer'),
		totalPages: Number(input.totalPages) || 1,
		addedAt: Number(input.addedAt) || Date.now()
	};
	for (const key of [
		'contentHash',
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
		'imslpPage'
	] as const) {
		if (input[key]) out[key] = String(input[key]);
	}
	if (input.annotationLayers)
		out.annotationLayers = input.annotationLayers.map((l) => ({
			id: String(l.id),
			name: String(l.name),
			visible: l.visible !== false
		}));
	if (input.metadataEdited) out.metadataEdited = true;
	if (input.composerId) out.composerId = String(input.composerId);
	if (input.composerPeriod) out.composerPeriod = String(input.composerPeriod);
	if (input.composerCountry)
		out.composerCountry = String(input.composerCountry);
	if (input.composerBirthPlace)
		out.composerBirthPlace = String(input.composerBirthPlace);
	if (input.composerBirthYear != null)
		out.composerBirthYear = Number(input.composerBirthYear);
	if (input.composerDeathYear != null)
		out.composerDeathYear = Number(input.composerDeathYear);
	if (input.year != null && !Number.isNaN(Number(input.year)))
		out.year = Number(input.year);
	else out.year = null;
	if (input.ensemble) out.ensemble = String(input.ensemble);
	if (input.instruments) out.instruments = String(input.instruments);
	if (input.pdfUrl) out.pdfUrl = String(input.pdfUrl);
	if (input.thumbnailUrl) out.thumbnailUrl = String(input.thumbnailUrl);
	if (input.thumbnailVersion != null)
		out.thumbnailVersion = Number(input.thumbnailVersion);
	if (input.lastOpenedAt != null) out.lastOpenedAt = Number(input.lastOpenedAt);
	out.favorite = !!input.favorite;
	out.tags = Array.isArray(input.tags) ? input.tags.map(String) : [];
	if (input.collection) out.collection = String(input.collection);
	if (input.sourceFolderId) out.sourceFolderId = String(input.sourceFolderId);
	if (input.sourcePath) out.sourcePath = String(input.sourcePath);
	if (input.nativePath) out.nativePath = String(input.nativePath);
	if (input.fileSize != null) out.fileSize = Number(input.fileSize);
	if (input.fileModifiedAt != null)
		out.fileModifiedAt = Number(input.fileModifiedAt);
	if (
		typeof Blob !== 'undefined' &&
		input.pdfBlob instanceof Blob &&
		input.pdfBlob.size > 0
	) {
		out.pdfBlob = input.pdfBlob;
	}
	return out;
}

/** Folder name under the library root — prefer stable composer id. */
export function composerFolderName(
	composerId: string | null | undefined,
	composerName: string
): string {
	const id = (composerId || '').trim();
	if (id) return sanitizeFolderSegment(id);
	return sanitizeFolderSegment(composerName || 'Unknown Composer');
}

function sanitizeFolderSegment(name: string): string {
	const s = name
		.trim()
		.replace(/[<>:"/\\|?*\x00-\x1f]/g, '-')
		.replace(/\s+/g, ' ')
		.replace(/[.\s]+$/g, '')
		.trim();
	return s || 'Unknown Composer';
}

type MovedScore = {
	native_path: string;
	relative_path: string;
	filename: string;
};

export async function migrateAnnotations(
	fromScoreId: string,
	toScoreId: string
) {
	if (fromScoreId === toScoreId) return;
	const rows = await db.annotations
		.where('scoreId')
		.equals(fromScoreId)
		.toArray();
	await db.transaction('rw', db.annotations, db.lists, async () => {
		await db.lists.toCollection().modify((list) => {
			list.entries = list.entries.map((entry) =>
				entry.scoreId === fromScoreId ? { ...entry, scoreId: toScoreId } : entry
			);
		});
		for (const row of rows) {
			await db.annotations.delete(row.id);
			await db.annotations.put({
				...row,
				id: `${toScoreId}:${row.pageNum}`,
				scoreId: toScoreId,
				stamps: row.stamps.map((stamp) => ({ ...stamp, scoreId: toScoreId })),
				notes: row.notes.map((note) => ({ ...note, scoreId: toScoreId }))
			});
		}
	});
}

/** Move a PDF and its sidecar according to the selected layout; migrate identity and annotations together. */
export async function maybeOrganizeScoreFile(
	existing: ScoreItem,
	next: ScoreItem,
	force = false
): Promise<ScoreItem> {
	const organize = get(settings).organizeByComposer;
	if ((!organize && !force) || !isTauri() || !existing.nativePath) return next;

	const folder = await db.folders.get(ROOT_FOLDER_ID);
	const libraryRoot = folder?.nativePath;
	if (!libraryRoot) return next;

	const preferences = get(settings);
	const targetFolder = composerFolderName(null, next.composer);
	const workFolder =
		preferences.fileOrganization === 'composer-work'
			? sanitizeFolderSegment(next.workTitle || next.title)
			: null;
	const targetParent =
		preferences.fileOrganization === 'flat'
			? ''
			: [targetFolder, workFolder].filter(Boolean).join('/');
	const currentParent =
		existing.sourcePath?.split('/').slice(0, -1).join('/') ?? '';
	if (currentParent === targetParent) {
		return next;
	}

	try {
		await invoke('save_score_sidecar', {
			sourcePath: existing.nativePath,
			libraryRoot,
			metadata: JSON.parse(
				JSON.stringify({
					...next,
					pdfBlob: undefined,
					pdfUrl: undefined,
					thumbnailUrl: undefined
				})
			)
		});
		const moved = await invoke<MovedScore>('move_score_into_composer_folder', {
			sourcePath: existing.nativePath,
			libraryRoot,
			composerFolder: targetFolder,
			workFolder,
			flat: preferences.fileOrganization === 'flat'
		});

		const newId = `${ROOT_FOLDER_ID}:${moved.relative_path}`;
		const updated = plainScore({
			...next,
			id: newId,
			nativePath: moved.native_path,
			sourcePath: moved.relative_path,
			sourceFolderId: ROOT_FOLDER_ID
		});

		await db.transaction(
			'rw',
			db.scores,
			db.annotations,
			db.lists,
			async () => {
				if (existing.id !== newId) {
					await migrateAnnotations(existing.id, newId);
					await db.scores.delete(existing.id);
				}
				await db.scores.put(updated);
			}
		);
		return updated;
	} catch (error) {
		throw new Error(`Could not organize “${next.title}”: ${String(error)}`);
	}
}

export async function saveScoreMetadata(
	id: string,
	payload: ScoreMetadataUpdate
): Promise<ScoreItem> {
	const existing = await db.scores.get(id);
	if (!existing) throw new Error('Score not found');

	const composer = payload.composerId
		? findComposer(payload.composerId)
		: findComposer(payload.composer);
	const next = plainScore({
		...existing,
		workTitle: payload.workTitle?.trim(),
		edition: payload.edition?.trim(),
		publisher: payload.publisher?.trim(),
		editor: payload.editor?.trim(),
		arranger: payload.arranger?.trim(),
		catalogue: payload.catalogue?.trim(),
		key: payload.key?.trim(),
		compositionDate: payload.compositionDate?.trim(),
		movements: payload.movements?.trim(),
		metadataEdited: true,
		title: String(payload.title || existing.title),
		composer:
			composer?.name ??
			String(payload.composer || existing.composer || 'Unknown Composer'),
		composerId: composer?.id ?? null,
		composerPeriod: composer?.period,
		composerCountry: composer?.country,
		composerBirthPlace: composer?.birthPlace,
		composerBirthYear: composer?.birthYear,
		composerDeathYear: composer?.deathYear,
		year: payload.year ?? null,
		ensemble: payload.ensemble ? String(payload.ensemble) : undefined,
		instruments: payload.instruments ? String(payload.instruments) : undefined,
		tags: Array.isArray(payload.tags) ? payload.tags.map(String) : []
	});

	if (isTauri() && next.nativePath) {
		const folder = await db.folders.get(ROOT_FOLDER_ID);
		if (folder?.nativePath)
			await invoke('save_score_sidecar', {
				sourcePath: next.nativePath,
				libraryRoot: folder.nativePath,
				metadata: JSON.parse(
					JSON.stringify({
						...next,
						pdfBlob: undefined,
						thumbnailUrl: undefined,
						pdfUrl: undefined
					})
				)
			});
	}
	await db.scores.put(next);

	const composerChanged =
		(existing.composerId || null) !== (next.composerId || null) ||
		existing.composer !== next.composer;

	if (composerChanged || existing.workTitle !== next.workTitle) {
		return maybeOrganizeScoreFile(existing, next);
	}
	return next;
}
