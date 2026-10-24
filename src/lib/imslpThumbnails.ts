import { invoke } from '@tauri-apps/api/core';
import { db } from './db';
const pending = new Map<string, Promise<string>>();
let active = 0;
const queue: Array<() => void> = [];
async function retrieve(url: string): Promise<string> {
	const cached = await db.imslpThumbnails.get(url).catch(() => undefined);
	if (cached && Date.now() - cached.fetchedAt < 30 * 86400000)
		return cached.data;
	if (active >= 4) await new Promise<void>((resolve) => queue.push(resolve));
	else active++;
	try {
		const data = await invoke<string>('imslp_thumbnail', { url });
		await db.imslpThumbnails
			.put({ url, data, fetchedAt: Date.now() })
			.catch(() => undefined);
		const count = await db.imslpThumbnails.count().catch(() => 0);
		if (count > 200) {
			const oldest = await db.imslpThumbnails
				.orderBy('fetchedAt')
				.limit(count - 200)
				.primaryKeys()
				.catch(() => []);
			await db.imslpThumbnails.bulkDelete(oldest).catch(() => undefined);
		}
		return data;
	} catch (error) {
		if (cached) return cached.data;
		throw error;
	} finally {
		const next = queue.shift();
		if (next) next();
		else active--;
	}
}
export function getImslpThumbnail(url: string) {
	let promise = pending.get(url);
	if (!promise) {
		promise = retrieve(url).finally(() => pending.delete(url));
		pending.set(url, promise);
	}
	return promise;
}
