import { db } from './db';
import { findComposer } from './composerDatabase';
import type { ScoreItem, ScoreMetadataUpdate } from './types';

export function plainScore(input: ScoreItem): ScoreItem {
	const out: ScoreItem = {
		id: String(input.id), title: String(input.title ?? ''),
		composer: String(input.composer ?? 'Unknown Composer'),
		totalPages: Number(input.totalPages) || 1, addedAt: Number(input.addedAt) || Date.now()
	};
	if (input.composerId) out.composerId = String(input.composerId);
	if (input.composerPeriod) out.composerPeriod = String(input.composerPeriod);
	if (input.composerCountry) out.composerCountry = String(input.composerCountry);
	if (input.composerBirthPlace) out.composerBirthPlace = String(input.composerBirthPlace);
	if (input.composerBirthYear != null) out.composerBirthYear = Number(input.composerBirthYear);
	if (input.composerDeathYear != null) out.composerDeathYear = Number(input.composerDeathYear);
	if (input.year != null && !Number.isNaN(Number(input.year))) out.year = Number(input.year); else out.year = null;
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
	if (typeof Blob !== 'undefined' && input.pdfBlob instanceof Blob && input.pdfBlob.size > 0) out.pdfBlob = input.pdfBlob;
	return out;
}

export async function saveScoreMetadata(id: string, payload: ScoreMetadataUpdate): Promise<ScoreItem> {
	const existing = await db.scores.get(id);
	if (!existing) throw new Error('Score not found');

	const composer = payload.composerId ? findComposer(payload.composerId) : findComposer(payload.composer);
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
	return next;
}
