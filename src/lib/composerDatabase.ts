import bundled from '../data/composers.json';

export interface ComposerRecord {
	id: string;
	name: string;
	aliases: string[];
	period: string;
	birthYear: number;
	deathYear: number;
	birthPlace: string;
	country: string;
	portraitFiles: string[];
	portraitQuery?: string;
}

/** Live list — starts as the bundled JSON, can be replaced by a remote fetch. */
export let COMPOSERS = bundled as ComposerRecord[];

function normalize(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');
}

let normalizedRecords = COMPOSERS.map((composer) => ({
	composer,
	terms: [composer.name, ...composer.aliases].map(normalize)
}));

function rebuildIndex() {
	normalizedRecords = COMPOSERS.map((composer) => ({
		composer,
		terms: [composer.name, ...composer.aliases].map(normalize)
	}));
}

export function getComposer(id: string): ComposerRecord | null {
	return COMPOSERS.find((composer) => composer.id === id) ?? null;
}

export function findComposer(value: string): ComposerRecord | null {
	const normalized = normalize(value);
	if (!normalized) return null;
	return (
		normalizedRecords.find(({ composer, terms }) => composer.id === normalized || terms.includes(normalized))
			?.composer ?? null
	);
}

export function searchComposers(query: string, limit = 8): ComposerRecord[] {
	const normalized = normalize(query);
	if (!normalized) return COMPOSERS.slice(0, limit);

	return normalizedRecords
		.map(({ composer, terms }) => {
			const exact = terms.some((term) => term === normalized);
			const starts = terms.some((term) => term.startsWith(normalized));
			const contains = terms.some((term) => term.includes(normalized));
			const name = normalize(composer.name);
			const score = exact ? 0 : starts ? 1 : name.startsWith(normalized) ? 2 : contains ? 3 : 99;
			return { composer, score };
		})
		.filter(({ score }) => score < 99)
		.sort((a, b) => a.score - b.score || a.composer.name.localeCompare(b.composer.name))
		.slice(0, limit)
		.map(({ composer }) => composer);
}

/** GitHub branch that hosts the live composer list + portraits. */
export const COMPOSER_REMOTE_BRANCH = 'development';

/** Base URL for remote portrait JPEGs (same branch as the JSON list). */
export const REMOTE_PORTRAIT_BASE = `https://raw.githubusercontent.com/Falconbird18/Sonora/${COMPOSER_REMOTE_BRANCH}/public/composers`;

/**
 * Preferred portrait URL for a composer.
 * Uses the remote GitHub raw URL so newly added or updated portraits appear
 * without shipping a new app build. Bundled `/composers/{id}.jpg` remains as
 * an offline fallback (see composerPortraits / ComposerPortrait).
 */
export function getComposerPortraitPath(composer: ComposerRecord): string {
	return `${REMOTE_PORTRAIT_BASE}/${composer.id}.jpg`;
}

/** Local static path (shipped with the app) — offline fallback only. */
export function getLocalComposerPortraitPath(composer: ComposerRecord): string {
	return `/composers/${composer.id}.jpg`;
}

// ─── Remote composer list ───────────────────────────────────────────────────

const REMOTE_URL = `https://raw.githubusercontent.com/Falconbird18/Sonora/${COMPOSER_REMOTE_BRANCH}/src/data/composers.json`;
const CACHE_KEY = 'sonora-composers-cache';
const CACHE_META_KEY = 'sonora-composers-cache-meta';
/** Re-fetch at most once per 6 hours unless forced (was 24h — tighter so list + portraits stay fresh). */
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

type CacheMeta = { fetchedAt: number; etag?: string; count: number };

function isValidComposerList(data: unknown): data is ComposerRecord[] {
	if (!Array.isArray(data) || data.length === 0) return false;
	const sample = data[0] as Record<string, unknown>;
	return (
		typeof sample?.id === 'string' &&
		typeof sample?.name === 'string' &&
		Array.isArray(sample?.aliases)
	);
}

function applyComposers(list: ComposerRecord[]) {
	COMPOSERS = list;
	rebuildIndex();
}

function loadCached(): ComposerRecord[] | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(CACHE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw);
		if (!isValidComposerList(parsed)) return null;
		return parsed;
	} catch {
		return null;
	}
}

function saveCache(list: ComposerRecord[], etag?: string) {
	if (typeof localStorage === 'undefined') return;
	try {
		localStorage.setItem(CACHE_KEY, JSON.stringify(list));
		const meta: CacheMeta = {
			fetchedAt: Date.now(),
			etag,
			count: list.length
		};
		localStorage.setItem(CACHE_META_KEY, JSON.stringify(meta));
	} catch {
		// Quota or private mode — ignore
	}
}

function getCacheMeta(): CacheMeta | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const raw = localStorage.getItem(CACHE_META_KEY);
		if (!raw) return null;
		return JSON.parse(raw) as CacheMeta;
	} catch {
		return null;
	}
}

export type ComposerRefreshResult = {
	updated: boolean;
	source: 'remote' | 'cache' | 'bundled';
	count: number;
	error?: string;
	/** True when we kicked off a background portrait sync. */
	portraitsSyncing?: boolean;
};

type PortraitSyncFn = (composers: ComposerRecord[], options?: { force?: boolean }) => Promise<void>;

let portraitSyncHandler: PortraitSyncFn | null = null;

/** Register the portrait cache sync (avoids circular imports). */
export function registerPortraitSync(handler: PortraitSyncFn) {
	portraitSyncHandler = handler;
}

function kickPortraitSync(list: ComposerRecord[], force = false) {
	if (!portraitSyncHandler) return false;
	void portraitSyncHandler(list, { force }).catch((err) =>
		console.warn('[Sonora] Portrait sync failed', err)
	);
	return true;
}

/**
 * Refresh COMPOSERS from the GitHub raw URL.
 * Falls back to localStorage cache, then the bundled JSON.
 * Safe to call on startup; network failures are non-fatal.
 * After a successful remote (or forced) refresh, portraits are synced in the background.
 */
export async function refreshComposersFromRemote(options?: {
	force?: boolean;
}): Promise<ComposerRefreshResult> {
	const meta = getCacheMeta();
	const cached = loadCached();
	const force = !!options?.force;

	// Prefer a still-fresh cache over a network hit
	if (!force && cached && meta && Date.now() - meta.fetchedAt < CACHE_TTL_MS) {
		if (cached.length !== COMPOSERS.length || cached[0]?.id !== COMPOSERS[0]?.id) {
			applyComposers(cached);
		}
		// Still ensure portraits for any newly cached composers are present
		const portraitsSyncing = kickPortraitSync(COMPOSERS, false);
		return { updated: false, source: 'cache', count: COMPOSERS.length, portraitsSyncing };
	}

	try {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'User-Agent': 'Sonora-composer-refresh'
		};
		if (meta?.etag && !force) headers['If-None-Match'] = meta.etag;

		const res = await fetch(REMOTE_URL, { headers });

		if (res.status === 304 && cached) {
			applyComposers(cached);
			saveCache(cached, meta?.etag);
			const portraitsSyncing = kickPortraitSync(COMPOSERS, force);
			return { updated: false, source: 'cache', count: COMPOSERS.length, portraitsSyncing };
		}

		if (!res.ok) {
			throw new Error(`HTTP ${res.status}`);
		}

		const data = (await res.json()) as unknown;
		if (!isValidComposerList(data)) {
			throw new Error('Invalid composer list shape');
		}

		const etag = res.headers.get('etag') ?? undefined;
		const changed =
			data.length !== COMPOSERS.length || JSON.stringify(data) !== JSON.stringify(COMPOSERS);
		applyComposers(data);
		saveCache(data, etag);

		const portraitsSyncing = kickPortraitSync(data, force || changed);

		return {
			updated: changed,
			source: 'remote',
			count: data.length,
			portraitsSyncing
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (cached) {
			applyComposers(cached);
			kickPortraitSync(COMPOSERS, false);
			return { updated: false, source: 'cache', count: COMPOSERS.length, error: message };
		}
		return { updated: false, source: 'bundled', count: COMPOSERS.length, error: message };
	}
}
