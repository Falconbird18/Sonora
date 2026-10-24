import type { LibraryFolder } from './types';

export function parentPath(path: string) {
	return path.split('/').slice(0, -1).join('/');
}
export function diskFolderId(path: string) {
	return path ? `disk:${path}` : '';
}
export function foldersFromPaths(paths: Iterable<string>): LibraryFolder[] {
	const folders = new Map<string, LibraryFolder>();
	for (const path of paths) {
		let current = '';
		for (const name of path.split('/').filter(Boolean)) {
			const parent = current;
			current = current ? `${current}/${name}` : name;
			if (!folders.has(current))
				folders.set(current, {
					id: diskFolderId(current),
					name,
					parentId: diskFolderId(parent),
					sourcePath: current,
					createdAt: 0
				});
		}
	}
	return [...folders.values()].sort((a, b) =>
		a.sourcePath!.localeCompare(b.sourcePath!)
	);
}
export function validateFolderName(name: string) {
	const trimmed = name.trim();
	if (
		!trimmed ||
		trimmed === '.' ||
		trimmed === '..' ||
		/[<>:"/\\|?*\x00-\x1f]/.test(trimmed) ||
		/[. ]$/.test(trimmed) ||
		trimmed.startsWith('.')
	)
		throw Error(
			'Use a folder name without slashes, special characters, or a leading dot.'
		);
	return trimmed;
}
