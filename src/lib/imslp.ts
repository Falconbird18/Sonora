/**
 * IMSLP integration for Sonora.
 *
 * Uses public IMSLP endpoints only:
 * - MediaWiki search + action=parse (wikitext) + imageinfo
 * - Official Special:IMSLPDisclaimerAccept download handshake → mirror URL
 *
 * Network work runs in Tauri (Rust) because browsers block cross-origin
 * requests to imslp.org.
 */

import { invoke } from '@tauri-apps/api/core';
import { isTauri } from './paths';
import { findComposer } from './composerDatabase';

export type ImslpSearchHit = {
	title: string;
	snippet: string;
	pageid?: number;
	thumb_url?: string | null;
};

export type ImslpScoreFile = {
	filename: string;
	description: string;
	editor: string;
	download_url: string;
	thumb_url?: string | null;
};

export type ImslpDownloadResult = {
	filename: string;
	size: number;
	saved_path?: string | null;
	relative_path?: string | null;
	bytes_base64?: string | null;
};

export type ImslpDownloadOptions = {
	libraryRoot?: string | null;
	/** Composer name used for the library folder + score tag (e.g. "Beethoven, Ludwig van"). */
	composer?: string | null;
	/** Full IMSLP work title, used to build a readable filename. */
	workTitle?: string | null;
};

export function imslpAvailable() {
	return isTauri();
}

/** Search works on IMSLP via MediaWiki API. */
export async function searchImslp(query: string, limit = 20): Promise<ImslpSearchHit[]> {
	const q = query.trim();
	if (!q) return [];
	if (!isTauri()) {
		throw new Error('IMSLP search requires the desktop app (network access is handled natively).');
	}
	return invoke<ImslpSearchHit[]>('imslp_search', { query: q, limit });
}

/** List PDF score files for a work by parsing the work-page wikitext via the API. */
export async function getWorkScores(workTitle: string): Promise<ImslpScoreFile[]> {
	if (!isTauri()) {
		throw new Error('IMSLP score listing requires the desktop app.');
	}
	return invoke<ImslpScoreFile[]>('imslp_work_scores', { workTitle });
}

/**
 * Download a score PDF via the official disclaimer → mirror URL flow.
 * When `libraryRoot` is set, the file is written under `{libraryRoot}/{Composer}/`.
 */
export async function downloadScore(
	filename: string,
	options?: ImslpDownloadOptions | string | null
): Promise<ImslpDownloadResult> {
	if (!isTauri()) {
		throw new Error('IMSLP download requires the desktop app.');
	}
	// Back-compat: second arg used to be libraryRoot string
	const opts: ImslpDownloadOptions =
		typeof options === 'string' || options === null || options === undefined
			? { libraryRoot: options ?? null }
			: options;
	return invoke<ImslpDownloadResult>('imslp_download_score', {
		filename,
		libraryRoot: opts.libraryRoot ?? null,
		composer: opts.composer ?? null,
		workTitle: opts.workTitle ?? null
	});
}


/** Parse "Title (Composer, Name)" style IMSLP work titles. */
export function parseWorkTitle(title: string): {
	title: string;
	composer: string;
	composerId: string | null;
} {
	const match = title.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
	if (!match) {
		return { title: title.trim(), composer: 'Unknown Composer', composerId: null };
	}
	const rawComposer = match[2].trim() || 'Unknown Composer';
	const workTitle = match[1].trim() || title.trim();

	// Resolve against composer DB: prefer "Last, First" → normal name + id
	const record =
		findComposer(rawComposer) ||
		// Try flipping "Beethoven, Ludwig van" → "Ludwig van Beethoven"
		(rawComposer.includes(',')
			? findComposer(
					rawComposer
						.split(',')
						.map((p) => p.trim())
						.reverse()
						.join(' ')
				)
			: null);

	return {
		title: workTitle,
		composer: record?.name ?? flipComposerName(rawComposer),
		composerId: record?.id ?? null
	};
}

/** "Beethoven, Ludwig van" → "Ludwig van Beethoven"; leave already-normal names alone. */
function flipComposerName(raw: string): string {
	const parts = raw.split(',').map((p) => p.trim()).filter(Boolean);
	if (parts.length >= 2) {
		return `${parts.slice(1).join(' ')} ${parts[0]}`.trim();
	}
	return raw;
}

/** Folder segment under library: capitalized composer id when known. */
export function imslpComposerFolder(composerId: string | null, composerName: string): string {
	if (composerId) {
		// "beethoven" → "Beethoven"
		return composerId.charAt(0).toUpperCase() + composerId.slice(1);
	}
	// Fallback: use flipped/normal name, still safe for FS
	return composerName || 'Unknown Composer';
}

export function workPageUrl(title: string) {
	return `https://imslp.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

/** Friendly short name from a raw IMSLP PDF filename. */
export function displayFilename(filename: string) {
	let name = filename
		.replace(/^PMLP\d+-?/i, '')
		.replace(/^IMSLP\d+-?/i, '')
		.replace(/_/g, ' ')
		.replace(/\.pdf$/i, '')
		.trim();
	name = name.replace(/\s+/g, ' ').replace(/^[\s\-–—]+|[\s\-–—]+$/g, '');
	return name || filename;
}
