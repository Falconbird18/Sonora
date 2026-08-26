import { db } from './db';
import { getFolderDescendantIds, isDescendantOf } from './folderTree';
import type { FolderSource, ScoreItem } from './types';

export async function setScoresFavorite(ids: string[], favorite: boolean) {
	if (!ids.length) return;
	await db.transaction('rw', db.scores, async () => {
		for (const id of ids) {
			const score = await db.scores.get(id);
			if (score) await db.scores.put({ ...score, favorite });
		}
	});
}

export async function moveScoresToFolder(ids: string[], folderId: string | null) {
	if (!ids.length) return;
	await db.transaction('rw', db.scores, async () => {
		for (const id of ids) {
			const score = await db.scores.get(id);
			if (score) await db.scores.put({ ...score, sourceFolderId: folderId ?? undefined });
		}
	});
}

export async function addTagToScores(ids: string[], tag: string) {
	const normalized = tag.trim();
	if (!ids.length || !normalized) return;
	await db.transaction('rw', db.scores, async () => {
		for (const id of ids) {
			const score = await db.scores.get(id);
			if (!score) continue;
			const tags = score.tags ?? [];
			if (!tags.some((value) => value.toLowerCase() === normalized.toLowerCase())) {
				await db.scores.put({ ...score, tags: [...tags, normalized] });
			}
		}
	});
}

export async function moveFolder(folders: FolderSource[], folderId: string, parentId: string | null) {
	const folder = folders.find((item) => item.id === folderId);
	if (!folder) throw new Error('Folder no longer exists.');
	if (parentId === folderId || (parentId && isDescendantOf(folders, parentId, folderId))) {
		throw new Error('A folder cannot be moved inside itself or one of its children.');
	}
	await db.folders.put({ ...folder, parentId: parentId ?? undefined });
}

export async function deleteFolderTree(folders: FolderSource[], folderId: string, deleteScores = false) {
	const ids = [folderId, ...getFolderDescendantIds(folders, folderId)];
	await db.transaction('rw', db.folders, db.scores, async () => {
		if (deleteScores) {
			const scores = await db.scores.where('sourceFolderId').anyOf(ids).toArray();
			for (const score of scores) await db.scores.delete(score.id);
		} else {
			const scores = await db.scores.where('sourceFolderId').anyOf(ids).toArray();
			for (const score of scores) await db.scores.put({ ...score, sourceFolderId: undefined });
		}
		await db.folders.bulkDelete(ids);
	});
}

export function folderScoreCounts(scores: ScoreItem[], folders: FolderSource[]) {
	const counts = new Map<string, number>();
	const children = new Map<string, string[]>();
	for (const folder of folders) {
		if (folder.parentId) {
			const list = children.get(folder.parentId) ?? [];
			list.push(folder.id);
			children.set(folder.parentId, list);
		}
	}
	for (const score of scores) {
		if (score.sourceFolderId) counts.set(score.sourceFolderId, (counts.get(score.sourceFolderId) ?? 0) + 1);
	}
	const accumulate = (id: string): number => {
		const total = (counts.get(id) ?? 0) + (children.get(id) ?? []).reduce((sum, child) => sum + accumulate(child), 0);
		counts.set(id, total);
		return total;
	};
	for (const folder of folders) if (!folder.parentId) accumulate(folder.id);
	return counts;
}
