/** Screen Wake Lock helpers so sheet music stays visible during practice. */

export type WakeLockHandle = {
	active: boolean;
	release: () => Promise<void>;
};

let current: WakeLockSentinel | null = null;

export function isWakeLockSupported(): boolean {
	return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

export async function acquireScreenWakeLock(): Promise<boolean> {
	if (!isWakeLockSupported()) return false;
	try {
		if (current) {
			try {
				await current.release();
			} catch {
				/* already released */
			}
			current = null;
		}
		current = await navigator.wakeLock.request('screen');
		current.addEventListener('release', () => {
			current = null;
		});
		return true;
	} catch (err) {
		// Denied, battery saver, or unsupported in this context
		console.debug('Screen Wake Lock request failed', err);
		current = null;
		return false;
	}
}

export async function releaseScreenWakeLock(): Promise<void> {
	if (!current) return;
	try {
		await current.release();
	} catch {
		/* ignore */
	}
	current = null;
}

export function isWakeLockHeld(): boolean {
	return current !== null && !current.released;
}
