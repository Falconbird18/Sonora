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
import { get } from 'svelte/store';
import { settings } from './settingsStore';
import { findComposer } from './composerDatabase';
import { isTauri } from './paths';

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
	publisher: string;
	arranger: string;
	copyright: string;
	section: string;
	download_url: string;
	thumb_url?: string | null;
};

export type ImslpWorkDetails = {
	files: ImslpScoreFile[];
	pageTitle: string;
	metadata: {
		title?: string;
		catalogue?: string;
		key?: string;
		instruments?: string;
		compositionDate?: string;
		movements?: string;
		period?: string;
	};
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
	metadata?: Record<string, unknown>;
};

const searchCache = new Map<
	string,
	{ at: number; value: Promise<ImslpSearchHit[]> }
>();
const workCache = new Map<
	string,
	{ at: number; value: Promise<ImslpWorkDetails> }
>();
function cached<T>(
	cache: Map<string, { at: number; value: Promise<T> }>,
	key: string,
	fetch: () => Promise<T>
): Promise<T> {
	const existing = cache.get(key);
	if (existing && Date.now() - existing.at < 5 * 60_000) return existing.value;
	const value = fetch().catch((error) => {
		cache.delete(key);
		throw error;
	});
	cache.set(key, { at: Date.now(), value });
	if (cache.size > 40) cache.delete(cache.keys().next().value!);
	return value;
}

export function imslpAvailable() {
	return isTauri();
}

/** Search works on IMSLP via MediaWiki API. */
export async function searchImslp(
	query: string,
	limit = 20
): Promise<ImslpSearchHit[]> {
	const q = query.trim();
	if (!q) return [];
	if (!isTauri()) {
		throw new Error(
			'IMSLP search requires the desktop app (network access is handled natively).'
		);
	}
	return cached(searchCache, `${q.toLocaleLowerCase()}:${limit}`, () =>
		invoke<ImslpSearchHit[]>('imslp_search', { query: q, limit })
	);
}

/** List PDF score files for a work by parsing the work-page wikitext via the API. */
export async function getWorkScores(
	workTitle: string
): Promise<ImslpWorkDetails> {
	if (!isTauri()) {
		throw new Error('IMSLP score listing requires the desktop app.');
	}
	return cached(workCache, workTitle, () =>
		invoke<ImslpWorkDetails>('imslp_work_scores', { workTitle })
	);
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
		workTitle: opts.workTitle ?? null,
		organization: get(settings).fileOrganization,
		metadata: opts.metadata ?? null
	});
}

/** Parse "Title (Composer, Name)" style IMSLP work titles. */
export function parseWorkTitle(title: string): {
	title: string;
	composer: string;
} {
	// IMSLP's final parenthesis is the composer; earlier parentheses belong to the title.
	if (!title.trimEnd().endsWith(')'))
		return { title: title.trim(), composer: 'Unknown Composer' };
	title = title.trim();
	let depth = 0;
	for (let i = title.length - 1; i >= 0; i--) {
		if (title[i] === ')') depth++;
		if (title[i] === '(' && --depth === 0) {
			const raw = title.slice(i + 1, -1).trim();
			if (
				!raw.includes(',') &&
				!findComposer(raw) &&
				!/^(anonymous|various|traditional)$/i.test(raw)
			)
				return { title, composer: 'Unknown Composer' };
			const canonical = raw.includes(',')
				? raw.split(',').slice(1).join(' ').trim() +
					' ' +
					raw.split(',')[0].trim()
				: raw;
			return {
				title: title.slice(0, i).trim(),
				composer:
					findComposer(raw)?.name ?? findComposer(canonical)?.name ?? canonical
			};
		}
	}
	return { title: title.trim(), composer: 'Unknown Composer' };
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
