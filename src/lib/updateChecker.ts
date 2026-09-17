/**
 * Checks GitHub Releases for a newer Sonora version.
 * Uses the public releases API (no auth). Safe to call from the frontend.
 *
 * Testing:
 * - Current package version is 1.2.0; latest published release is still v1.1.x,
 *   so the checker correctly reports "up to date".
 * - To force a positive result for manual testing, temporarily lower
 *   CURRENT_VERSION below the latest tag, or publish a release with a higher tag.
 * - Or call checkForUpdate({ force: true }) after setting localStorage
 *   key "sonora-force-update-tag" to e.g. "v9.9.9".
 */

export const CURRENT_VERSION = '1.2.0';

const REPO = 'Falconbird18/Sonora';
const RELEASES_LATEST = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASES_LIST = `https://api.github.com/repos/${REPO}/releases?per_page=5`;

export type UpdateInfo = {
	available: boolean;
	currentVersion: string;
	latestVersion: string | null;
	tagName: string | null;
	name: string | null;
	body: string | null;
	htmlUrl: string | null;
	publishedAt: string | null;
	error?: string;
};

function normalizeVersion(raw: string): string {
	return raw.trim().replace(/^v/i, '');
}

/** Compare semver-ish strings. Returns true if a > b. */
export function isNewerVersion(a: string, b: string): boolean {
	const pa = normalizeVersion(a)
		.split(/[^0-9]+/)
		.filter(Boolean)
		.map((n) => parseInt(n, 10) || 0);
	const pb = normalizeVersion(b)
		.split(/[^0-9]+/)
		.filter(Boolean)
		.map((n) => parseInt(n, 10) || 0);
	const len = Math.max(pa.length, pb.length);
	for (let i = 0; i < len; i++) {
		const x = pa[i] ?? 0;
		const y = pb[i] ?? 0;
		if (x > y) return true;
		if (x < y) return false;
	}
	return false;
}

type GhRelease = {
	tag_name?: string;
	name?: string;
	body?: string;
	html_url?: string;
	published_at?: string;
	draft?: boolean;
	prerelease?: boolean;
};

async function fetchJson<T>(url: string): Promise<T> {
	const res = await fetch(url, {
		headers: {
			Accept: 'application/vnd.github+json',
			'User-Agent': `Sonora/${CURRENT_VERSION}`
		}
	});
	if (!res.ok) {
		throw new Error(`GitHub API ${res.status}: ${res.statusText}`);
	}
	return (await res.json()) as T;
}

export async function checkForUpdate(options?: {
	force?: boolean;
	includePrerelease?: boolean;
}): Promise<UpdateInfo> {
	const current = CURRENT_VERSION;
	const forceTag =
		typeof localStorage !== 'undefined'
			? localStorage.getItem('sonora-force-update-tag')
			: null;

	try {
		let release: GhRelease | null = null;

		if (forceTag) {
			// Dev/test override: pretend this tag is the latest
			release = {
				tag_name: forceTag,
				name: `Forced test release ${forceTag}`,
				body: 'This is a forced update check for testing (localStorage sonora-force-update-tag).',
				html_url: `https://github.com/${REPO}/releases`,
				published_at: new Date().toISOString()
			};
		} else if (options?.includePrerelease) {
			const list = await fetchJson<GhRelease[]>(RELEASES_LIST);
			release =
				list.find((r) => !r.draft) ?? null;
		} else {
			try {
				release = await fetchJson<GhRelease>(RELEASES_LATEST);
			} catch {
				// No "latest" (e.g. only prereleases) — fall back to list
				const list = await fetchJson<GhRelease[]>(RELEASES_LIST);
				release = list.find((r) => !r.draft && !r.prerelease) ?? list.find((r) => !r.draft) ?? null;
			}
		}

		if (!release?.tag_name) {
			return {
				available: false,
				currentVersion: current,
				latestVersion: null,
				tagName: null,
				name: null,
				body: null,
				htmlUrl: `https://github.com/${REPO}/releases`,
				publishedAt: null
			};
		}

		const latest = normalizeVersion(release.tag_name);
		const available = isNewerVersion(latest, current);

		return {
			available,
			currentVersion: current,
			latestVersion: latest,
			tagName: release.tag_name,
			name: release.name ?? null,
			body: release.body ?? null,
			htmlUrl: release.html_url ?? `https://github.com/${REPO}/releases/tag/${release.tag_name}`,
			publishedAt: release.published_at ?? null
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		return {
			available: false,
			currentVersion: current,
			latestVersion: null,
			tagName: null,
			name: null,
			body: null,
			htmlUrl: `https://github.com/${REPO}/releases`,
			publishedAt: null,
			error: message
		};
	}
}

const DISMISS_KEY = 'sonora-dismissed-update';

export function getDismissedUpdateTag(): string | null {
	if (typeof localStorage === 'undefined') return null;
	return localStorage.getItem(DISMISS_KEY);
}

export function dismissUpdate(tagName: string) {
	if (typeof localStorage === 'undefined') return;
	localStorage.setItem(DISMISS_KEY, tagName);
}

export function shouldShowUpdateBanner(info: UpdateInfo): boolean {
	if (!info.available || !info.tagName) return false;
	const dismissed = getDismissedUpdateTag();
	return dismissed !== info.tagName;
}
