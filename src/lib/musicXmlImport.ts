import { db } from './db';
import { getPdfInfoFromSource } from './pdfUtils';
import { findComposer } from './composerDatabase';
import type { ScoreItem } from './types';
import { readOmrArtifact, type OmrJob } from './omr';

/** Store the untouched source in IndexedDB, independent of a temporary OMR job. */
export async function prepareMusicXml(
	blob: Blob,
	filename: string,
	source?: Partial<ScoreItem>,
	id?: string
): Promise<ScoreItem> {
	if (!blob.size || blob.size > 64 * 1024 * 1024)
		throw Error('Choose a MusicXML file smaller than 64 MB.');
	const extension = /\.mxl$/i.test(filename) ? 'mxl' : 'musicxml';
	const payload = blob.slice(
		0,
		blob.size,
		extension === 'mxl'
			? 'application/vnd.recordare.musicxml'
			: 'application/vnd.recordare.musicxml+xml'
	);
	let title = source?.title || filename.replace(/\.(musicxml|xml|mxl)$/i, '');
	let composer = source?.composer || 'Unknown Composer';
	if (extension !== 'mxl') {
		const xml = new DOMParser().parseFromString(
			await payload.text(),
			'application/xml'
		);
		if (
			xml.querySelector('parsererror') ||
			!['score-partwise', 'score-timewise'].includes(
				xml.documentElement.localName
			)
		)
			throw Error('This file is not a valid MusicXML score.');
		title =
			xml.querySelector('work-title, movement-title')?.textContent?.trim() ||
			title;
		composer =
			xml.querySelector('creator[type="composer"]')?.textContent?.trim() ||
			composer;
	}
	const hash = [
		...new Uint8Array(
			await crypto.subtle.digest('SHA-256', await payload.arrayBuffer())
		)
	]
		.map((byte) => byte.toString(16).padStart(2, '0'))
		.join('');
	const info = await getPdfInfoFromSource({ blob: payload });
	return {
		id: id || `musicxml:${hash}`,
		format: 'musicxml',
		fileExtension: extension,
		title,
		composer,
		composerId: findComposer(composer)?.id,
		pdfBlob: payload,
		totalPages: info.totalPages,
		thumbnailUrl: info.thumbnailUrl,
		thumbnailVersion: 2,
		contentHash: hash,
		addedAt: Date.now(),
		collection: 'Digitized scores',
		tags: ['MusicXML']
	};
}

export async function convertedMusicXml(
	job: OmrJob,
	index: number,
	source?: Partial<ScoreItem>
) {
	const artifact = job.artifacts[index];
	if (artifact?.kind !== 'musicxml') throw Error('Choose a MusicXML movement.');
	const xml = await readOmrArtifact(job.id, index);
	return prepareMusicXml(
		new Blob([xml]),
		artifact.name,
		source,
		`omr:${job.id}:${index}`
	);
}

export async function keepMusicXml(score: ScoreItem) {
	const existing = await db.scores.get(score.id);
	if (existing) return existing;
	await db.scores.add(score);
	return score;
}
