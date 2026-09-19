import {
	COMPOSERS,
	findComposer,
	getComposerPortraitPath,
	getLocalComposerPortraitPath,
	registerPortraitSync,
	REMOTE_PORTRAIT_BASE,
	type ComposerRecord
} from './composerDatabase';
import { db, type ComposerPortraitCache } from './db';

export const COMPOSER_KEYS = COMPOSERS.map((composer) => composer.id) as readonly string[];
export type ComposerKey = string;
export type ComposerData = ComposerRecord & { portraitUrl: string };

/** In-memory object URLs keyed by composer id (revoked/replaced when cache updates). */
const objectUrlById = new Map<string, string>();
/** Listeners notified when a portrait URL becomes available or changes. */
const listeners = new Set<(id: string, url: string) => void>();

export function onPortraitUpdate(listener: (id: string, url: string) => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

function notify(id: string, url: string) {
	for (const listener of listeners) {
		try {
			listener(id, url);
		} catch {
			/* ignore */
		}
	}
}

function setObjectUrl(id: string, blob: Blob): string {
	const prev = objectUrlById.get(id);
	if (prev) URL.revokeObjectURL(prev);
	const url = URL.createObjectURL(blob);
	objectUrlById.set(id, url);
	notify(id, url);
	return url;
}

export function resolveComposerKey(name: string): ComposerKey | null {
	return findComposer(name)?.id ?? null;
}

/**
 * Synchronous best-effort URL:
 * 1. Cached blob object URL (from a previous sync)
 * 2. Remote GitHub raw URL (works online; updates within GitHub CDN TTL)
 * 3. Empty string if unknown composer
 *
 * Components should prefer the remote/local pair via getComposerPortraitSources
 * and react to onPortraitUpdate for cached blobs.
 */
export function getComposerPortrait(name: string): string {
	const composer = findComposer(name);
	if (!composer) return '';
	return objectUrlById.get(composer.id) ?? getComposerPortraitPath(composer);
}

export function getComposerData(name: string): ComposerData | null {
	const composer = findComposer(name);
	if (!composer) return null;
	return {
		...composer,
		portraitUrl: objectUrlById.get(composer.id) ?? getComposerPortraitPath(composer)
	};
}

export type PortraitSources = {
	/** Preferred src (blob cache or remote). */
	src: string;
	/** Bundled local path for offline of the original set. */
	local: string;
	/** Remote GitHub raw URL. */
	remote: string;
	id: string;
};

export function getComposerPortraitSources(nameOrId: string): PortraitSources | null {
	const composer = findComposer(nameOrId);
	if (!composer) return null;
	const remote = getComposerPortraitPath(composer);
	const local = getLocalComposerPortraitPath(composer);
	const cached = objectUrlById.get(composer.id);
	return {
		id: composer.id,
		src: cached ?? remote,
		local,
		remote
	};
}

async function loadCachedPortrait(id: string): Promise<ComposerPortraitCache | undefined> {
	try {
		return await db.composerPortraits.get(id);
	} catch {
		return undefined;
	}
}

async function storePortrait(id: string, blob: Blob, etag?: string) {
	const row: ComposerPortraitCache = {
		id,
		blob,
		etag,
		fetchedAt: Date.now()
	};
	try {
		await db.composerPortraits.put(row);
	} catch (err) {
		console.warn('[Sonora] Could not cache portrait', id, err);
	}
	setObjectUrl(id, blob);
}

/**
 * Ensure a single portrait is in the IDB + memory cache.
 * Uses conditional requests when we already have an etag.
 */
export async function ensurePortraitCached(
	composer: ComposerRecord,
	options?: { force?: boolean }
): Promise<string | null> {
	const id = composer.id;
	const existing = await loadCachedPortrait(id);

	if (existing?.blob && !options?.force) {
		if (!objectUrlById.has(id)) setObjectUrl(id, existing.blob);
		// Still revalidate in the background occasionally (>7 days)
		if (Date.now() - existing.fetchedAt < 7 * 24 * 60 * 60 * 1000) {
			return objectUrlById.get(id) ?? null;
		}
	}

	const remote = `${REMOTE_PORTRAIT_BASE}/${id}.jpg`;
	const headers: Record<string, string> = {
		Accept: 'image/jpeg,image/*,*/*',
		'User-Agent': 'Sonora-portrait-sync'
	};
	if (existing?.etag && !options?.force) {
		headers['If-None-Match'] = existing.etag;
	}

	try {
		const res = await fetch(remote, { headers });
		if (res.status === 304 && existing?.blob) {
			await db.composerPortraits.update(id, { fetchedAt: Date.now() });
			if (!objectUrlById.has(id)) setObjectUrl(id, existing.blob);
			return objectUrlById.get(id) ?? null;
		}
		if (!res.ok) {
			// Fall back to any existing cache or leave remote URL to the img tag
			if (existing?.blob) {
				if (!objectUrlById.has(id)) setObjectUrl(id, existing.blob);
				return objectUrlById.get(id) ?? null;
			}
			return null;
		}
		const blob = await res.blob();
		if (blob.size < 400 || !(blob.type.startsWith('image/') || blob.type === '')) {
			return null;
		}
		const etag = res.headers.get('etag') ?? undefined;
		await storePortrait(id, blob, etag);
		return objectUrlById.get(id) ?? null;
	} catch {
		if (existing?.blob) {
			if (!objectUrlById.has(id)) setObjectUrl(id, existing.blob);
			return objectUrlById.get(id) ?? null;
		}
		return null;
	}
}

let syncRunning = false;

/**
 * Background-sync portraits for the given composer list.
 * Missing or stale images are fetched from GitHub and stored in IndexedDB.
 */
export async function syncComposerPortraits(
	composers: ComposerRecord[],
	options?: { force?: boolean }
): Promise<void> {
	if (syncRunning) return;
	syncRunning = true;
	try {
		// Hydrate memory from IDB first (fast offline paint)
		const ids = composers.map((c) => c.id);
		try {
			const rows = await db.composerPortraits.bulkGet(ids);
			for (const row of rows) {
				if (row?.blob && !objectUrlById.has(row.id)) {
					setObjectUrl(row.id, row.blob);
				}
			}
		} catch {
			/* table may not exist yet on first open before upgrade */
		}

		// Sequential-ish with small concurrency to avoid hammering GitHub
		const concurrency = 4;
		let i = 0;
		async function worker() {
			while (i < composers.length) {
				const idx = i++;
				const composer = composers[idx];
				if (!composer) continue;
				await ensurePortraitCached(composer, options);
				await new Promise((r) => setTimeout(r, 30));
			}
		}
		await Promise.all(Array.from({ length: concurrency }, () => worker()));
	} finally {
		syncRunning = false;
	}
}

// Wire into composer list refresh (avoids circular import at module init time)
registerPortraitSync(syncComposerPortraits);

/** Preload object URLs from IDB for the current COMPOSERS list (call on app start). */
export async function hydratePortraitCache(): Promise<void> {
	try {
		const rows = await db.composerPortraits.toArray();
		for (const row of rows) {
			if (row.blob && !objectUrlById.has(row.id)) {
				setObjectUrl(row.id, row.blob);
			}
		}
	} catch {
		/* ignore */
	}
}
