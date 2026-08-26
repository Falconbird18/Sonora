import type { FolderSource } from './types';

export interface FolderTreeNode extends FolderSource {
	children: FolderTreeNode[];
	depth: number;
	scoreCount?: number;
}

export function buildFolderTree(folders: FolderSource[], scoreCounts = new Map<string, number>()): FolderTreeNode[] {
	const nodes = new Map<string, FolderTreeNode>();
	for (const folder of folders) {
		nodes.set(folder.id, { ...folder, children: [], depth: 0, scoreCount: scoreCounts.get(folder.id) ?? 0 });
	}
	const roots: FolderTreeNode[] = [];
	for (const node of nodes.values()) {
		const parent = node.parentId ? nodes.get(node.parentId) : undefined;
		if (parent && parent.id !== node.id) parent.children.push(node);
		else roots.push(node);
	}
	const sort = (items: FolderTreeNode[], depth: number) => {
		items.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
		for (const item of items) { item.depth = depth; sort(item.children, depth + 1); }
	};
	sort(roots, 0);
	return roots;
}

export function flattenFolderTree(nodes: FolderTreeNode[]): FolderTreeNode[] {
	const result: FolderTreeNode[] = [];
	const visit = (node: FolderTreeNode) => { result.push(node); for (const child of node.children) visit(child); };
	for (const node of nodes) visit(node);
	return result;
}

export function getFolderDescendantIds(folders: FolderSource[], folderId: string): string[] {
	const children = new Map<string, string[]>();
	for (const folder of folders) {
		if (!folder.parentId) continue;
		const list = children.get(folder.parentId) ?? [];
		list.push(folder.id);
		children.set(folder.parentId, list);
	}
	const result: string[] = [];
	const seen = new Set<string>();
	const visit = (id: string) => {
		for (const child of children.get(id) ?? []) {
			if (child === folderId || seen.has(child)) continue;
			seen.add(child); result.push(child); visit(child);
		}
	};
	visit(folderId);
	return result;
}

export function getFolderPath(folders: FolderSource[], folderId: string): FolderSource[] {
	const byId = new Map(folders.map((folder) => [folder.id, folder]));
	const path: FolderSource[] = [];
	const seen = new Set<string>();
	let current = byId.get(folderId);
	while (current && !seen.has(current.id)) {
		seen.add(current.id); path.unshift(current);
		current = current.parentId ? byId.get(current.parentId) : undefined;
	}
	return path;
}

export function isDescendantOf(folders: FolderSource[], candidateId: string, ancestorId: string): boolean {
	if (candidateId === ancestorId) return true;
	const byId = new Map(folders.map((folder) => [folder.id, folder]));
	const seen = new Set<string>();
	let current = byId.get(candidateId);
	while (current?.parentId && !seen.has(current.id)) {
		seen.add(current.id);
		if (current.parentId === ancestorId) return true;
		current = byId.get(current.parentId);
	}
	return false;
}
