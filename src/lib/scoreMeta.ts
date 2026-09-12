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
	if (input.composerId) out.composerId = String(input.composerId);
	if (input.composerPeriod) out.composerPeriod = String(input.composerPeriod);
	if (input.composerCountry) out.composerCountry = String(input.composerCountry);
	if (input.composerBirthPlace) out.composerBirthPlace = String(input.composerBirthPlace);
	if (input.composerBirthYear != null) out.composerBirthYear = Number(input.composerBirthYear);
	if (input.composerDeathYear != null) out.composerDeathYear = Number(input.composerDeathYear);
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
	if (typeof Blob !== 'undefined' && input.pdfBlob instanceof Blob && input.pdfBlob.size > 0) {
		out.pdfBlob = input.pdfBlob;
	}
	return out;
}

/** Folder name under the library root — prefer stable composer id. */
export function composerFolderName(composerId: string | null | undefined, composerName: string): string {
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

function relativeParentFolder(relativePath: string | undefined): string | null {
	if (!relativePath) return null;
	const normalized = relativePath.replace(/\\/g, '/');
	const parts = normalized.split('/').filter(Boolean);
	if (parts.length < 2) return null;
	return parts[0];
}

async function migrateAnnotations(fromScoreId: string, toScoreId: string) {
	if (fromScoreId === toScoreId) return;
	const rows = await db.annotations.where('scoreId').equals(fromScoreId).toArray();
	if (!rows.length) return;
	await db.transaction('rw', db.annotations, async () => {
		for (const row of rows) {
			await db.annotations.delete(row.id);
			await db.annotations.put({ ...row, scoreId: toScoreId });
		}
	});
}

/**
 * When organize-by-composer is enabled, move the PDF into
 * `{libraryRoot}/{composerId}/filename.pdf` and update DB paths / id.
 */
async function maybeOrganizeScoreFile(
	existing: ScoreItem,
	next: ScoreItem
): Promise<ScoreItem> {
	const organize = get(settings).organizeByComposer;
	if (!organize || !isTauri() || !existing.nativePath) return next;

	const folder = await db.folders.get(ROOT_FOLDER_ID);
	const libraryRoot = folder?.nativePath;
	if (!libraryRoot) return next;

	const targetFolder = composerFolderName(next.composerId, next.composer);
	const currentParent = relativeParentFolder(existing.sourcePath);
	if (currentParent && currentParent === targetFolder) {
		return next;
	}

	try {
		const moved = await invoke<MovedScore>('move_score_into_composer_folder', {
			sourcePath: existing.nativePath,
			libraryRoot,
			composerFolder: targetFolder
		});

		const newId = `${ROOT_FOLDER_ID}:${moved.relative_path}`;
		const updated = plainScore({
			...next,
			id: newId,
			nativePath: moved.native_path,
			sourcePath: moved.relative_path,
			sourceFolderId: ROOT_FOLDER_ID
		});

		if (existing.id !== newId) {
			await db.scores.delete(existing.id);
			await migrateAnnotations(existing.id, newId);
		}
		await db.scores.put(updated);
		return updated;
	} catch (error) {
		console.warn('[Sonora] Could not reorganize score file by composer', error);
		return next;
	}
}

export async function saveScoreMetadata(id: string, payload: ScoreMetadataUpdate): Promise<ScoreItem> {
	const existing = await db.scores.get(id);
	if (!existing) throw new Error('Score not found');

	const composer = payload.composerId
		? findComposer(payload.composerId)
		: findComposer(payload.composer);
	const next = plainScore({
		...existing,
		title: String(payload.title || existing.title),
		composer: composer?.name ?? String(payload.composer || existing.composer || 'Unknown Composer'),
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

	await db.scores.put(next);

	const composerChanged =
		(existing.composerId || null) !== (next.composerId || null) ||
		existing.composer !== next.composer;

	if (composerChanged) {
		return maybeOrganizeScoreFile(existing, next);
	}
	return next;
}
