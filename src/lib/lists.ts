import { db } from './db';
import type { ScoreList, ListEntry } from './types';

export function reorderEntries(
	entries: ListEntry[],
	entryId: string,
	targetIndex: number
): ListEntry[] {
	const current = entries.findIndex((entry) => entry.id === entryId);
	if (current < 0) return [...entries];
	const next = [...entries];
	const [entry] = next.splice(current, 1);
	next.splice(Math.max(0, Math.min(next.length, targetIndex)), 0, entry);
	return next;
}
export async function createList(name: string): Promise<ScoreList> {
	const now = Date.now();
	const list: ScoreList = {
		id: crypto.randomUUID(),
		name: name.trim() || 'Untitled list',
		description: '',
		entries: [],
		createdAt: now,
		updatedAt: now
	};
	await db.lists.add(list);
	return list;
}
export async function updateList(
	id: string,
	change: (list: ScoreList) => ScoreList
) {
	await db.transaction('rw', db.lists, async () => {
		const current = await db.lists.get(id);
		if (!current) throw new Error('List no longer exists');
		const next = change(current);
		await db.lists.put({ ...next, id: current.id, updatedAt: Date.now() });
	});
}
export async function addToList(listId: string, scoreIds: string[]) {
	await updateList(listId, (list) => ({
		...list,
		entries: [
			...list.entries,
			...scoreIds.map((scoreId) => ({ id: crypto.randomUUID(), scoreId }))
		]
	}));
}
