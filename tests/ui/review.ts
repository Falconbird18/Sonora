// Run on an isolated origin: npm run dev -- --port 5175, then /tests/ui/.
// This harness uses fixture data; native integration is covered by Rust tests.
import { mount } from 'svelte';
import { db } from '../../src/lib/db';
import {
	foldersFromPaths,
	diskFolderId,
	parentPath
} from '../../src/lib/libraryFolderPaths';
import LibraryView from '../../src/lib/LibraryView.svelte';
import '../../src/app.css';
if (
	!import.meta.env.DEV ||
	(await db.scores.toArray()).some(
		(score) =>
			!score.id.startsWith('review-') &&
			!score.nativePath?.startsWith('/review/')
	)
)
	throw new Error('Use an empty, isolated review origin.');
await db.scores.clear();
await db.libraryFolders.clear();
const image = await fetch('/tests/ui/score-preview.png').then((r) => r.blob());
const data = await new Promise<string>((resolve) => {
	const reader = new FileReader();
	reader.onload = () => resolve(String(reader.result));
	reader.readAsDataURL(image);
});
const work = 'Piano Sonata No.19, Op.49 No.1';
const composer = 'Ludwig van Beethoven';
const editions = [
	{
		filename: 'PMLP01471-Op.49-1.pdf',
		description: 'Complete Score · Scan',
		publisher: 'Bureau des Arts et d’Industrie, Vienna, 1805',
		editor: 'First edition',
		arranger: '',
		copyright: 'Public Domain',
		section: 'Scores',
		thumb_url: 'https://imslp.org/review.jpg'
	},
	{
		filename: 'PMLP1471-420.pdf',
		description: 'Complete Score · Scan',
		publisher: 'Eduard Hallberger, Stuttgart, ca.1860',
		editor: 'Ignaz Moscheles',
		arranger: '',
		copyright: 'Public Domain',
		section: 'Scores',
		thumb_url: 'https://imslp.org/review.jpg'
	},
	{
		filename: 'PMLP1471-Vl1_1.pdf',
		description: 'Violins I · Typeset',
		publisher: 'Joshua Choe, 2020',
		editor: '',
		arranger: 'Joshua Choe',
		copyright: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0',
		section: 'For Strings (Choe)',
		thumb_url: 'https://imslp.org/review.jpg'
	}
];
await db.folders.put({
	id: 'library-root',
	name: 'Review collection',
	nativePath: '/review',
	addedAt: 1,
	autoSync: false
});
await db.scores.bulkPut([
	...editions.map((e, i) => ({
		id: `review-${i}`,
		title: work,
		workTitle: work,
		composer,
		edition: e.description,
		publisher: e.publisher,
		editor: e.editor,
		arranger: e.arranger,
		catalogue: 'Op.49 No.1',
		key: 'G minor',
		instruments: 'piano',
		compositionDate: '1797',
		totalPages: 9,
		addedAt: Date.now() - i,
		thumbnailUrl: data,
		thumbnailVersion: 2,
		favorite: i === 0
	})),
	{
		id: 'review-symphony',
		title: 'Symphony No.9, Op.125',
		composer,
		edition: 'Complete Score',
		instruments: 'orchestra, choir',
		totalPages: 208,
		addedAt: 1,
		thumbnailUrl: data,
		thumbnailVersion: 2
	},
	{
		id: 'review-bach',
		title: 'Cello Suites, BWV 1007–1012',
		composer: 'Johann Sebastian Bach',
		edition: 'Complete Score',
		totalPages: 40,
		addedAt: 2,
		thumbnailUrl: data,
		thumbnailVersion: 2
	},
	{
		id: 'review-debussy',
		title: 'Suite bergamasque, L.75',
		composer: 'Claude Debussy',
		edition: 'Complete Score',
		totalPages: 22,
		addedAt: 3,
		thumbnailUrl: data,
		thumbnailVersion: 2
	}
]);
await db.lists.put({
	id: 'review-program',
	name: 'Evening recital',
	description: 'An ordered concert program',
	createdAt: 1,
	updatedAt: 2,
	entries: [
		{ id: 'review-entry1', scoreId: 'review-0' },
		{ id: 'review-entry2', scoreId: 'review-bach' },
		{ id: 'review-entry3', scoreId: 'review-0' }
	]
});
// Exercise annotation identity migration against actual browser IndexedDB.
const { migrateAnnotations } = await import('../../src/lib/scoreMeta');
await db.annotations.put({
	id: 'review-before:1',
	scoreId: 'review-before',
	pageNum: 1,
	strokes: [],
	stamps: [],
	notes: []
});
await db.lists.put({
	id: 'review-move',
	name: 'Migration test',
	description: '',
	createdAt: 1,
	updatedAt: 1,
	entries: [{ id: 'move', scoreId: 'review-before' }]
});
await migrateAnnotations('review-before', 'review-after');
if ((await db.lists.get('review-move'))?.entries[0].scoreId !== 'review-after')
	throw new Error('List reference migration failed');
await db.lists.delete('review-move');
if (
	!(await db.annotations.get('review-after:1')) ||
	(await db.annotations.get('review-before:1'))
)
	throw new Error('Annotation migration failed');
await db.annotations.delete('review-after:1');

// In-memory disk fixture exercises native path changes through the real UI and catalogue.
const paths: Record<string, string> = {
	'review-0': 'Beethoven/Sonatas/First edition.pdf',
	'review-1': 'Beethoven/Sonatas/Hallberger.pdf',
	'review-2': 'Beethoven/Sonatas/Violin I.pdf',
	'review-symphony': 'Beethoven/Symphony No.9.pdf',
	'review-bach': 'Bach/Cello Suites.pdf',
	'review-debussy': 'Debussy/Suite bergamasque.pdf'
};
const directories = new Set([
	'Bach',
	'Beethoven',
	'Beethoven/Sonatas',
	'Debussy',
	'Rehearsal',
	'Rehearsal/Parts'
]);
for (const score of await db.scores.toArray()) {
	const path = paths[score.id];
	await db.scores.update(score.id, {
		sourcePath: path,
		sourceFolderId: 'library-root',
		nativePath: `/review/${path}`,
		folderId: diskFolderId(parentPath(path)),
		fileSize: 16,
		fileModifiedAt: 100
	});
}
await db.libraryFolders.bulkPut(foldersFromPaths(directories));
const diskFiles = new Map(
	(await db.scores.toArray()).map((score) => [score.sourcePath!, score])
);
Object.assign(window, {
	__TAURI_INTERNALS__: {
		convertFileSrc: (path: string) => `asset://localhost/${path}`,
		invoke: async (command: string, args: Record<string, string> = {}) => {
			if (command === 'list_score_tree')
				return {
					directories: [...directories],
					files: [...diskFiles].map(([path, metadata]) => ({
						path: `/review/${path}`,
						relative_path: path,
						name: path.split('/').at(-1),
						size: 16,
						modified_at: 100,
						metadata
					}))
				};
			if (command === 'create_score_directory') {
				if (directories.has(args.relativePath))
					throw Error('A folder with that name already exists.');
				directories.add(args.relativePath);
				return;
			}
			if (command === 'delete_score_directory') {
				if (!args.relativePath || !directories.has(args.relativePath))
					throw Error('Invalid folder deletion');
				for (const path of [...directories])
					if (
						path === args.relativePath ||
						path.startsWith(`${args.relativePath}/`)
					)
						directories.delete(path);
				for (const path of [...diskFiles.keys()])
					if (path.startsWith(`${args.relativePath}/`)) diskFiles.delete(path);
				return;
			}
			if (command === 'move_score_entry') {
				const source = args.sourceRelative,
					target = args.destinationRelative;
				if (source === target) return;
				if (target.startsWith(`${source}/`))
					throw Error('A folder cannot be moved inside itself.');
				if (directories.has(target) || diskFiles.has(target))
					throw Error('An item with that name already exists.');
				for (const path of [...directories])
					if (path === source || path.startsWith(`${source}/`)) {
						directories.delete(path);
						directories.add(target + path.slice(source.length));
					}
				for (const [path, score] of [...diskFiles])
					if (path === source || path.startsWith(`${source}/`)) {
						diskFiles.delete(path);
						diskFiles.set(target + path.slice(source.length), score);
					}
				return;
			}
			if (command === 'list_score_files') return [];
			if (command === 'imslp_thumbnail') return data;
			if (command === 'imslp_search')
				return [work, 'Symphony No.9, Op.125'].map((title) => ({
					title: `${title} (Beethoven, Ludwig van)`,
					snippet: '',
					thumb_url: 'https://imslp.org/review.jpg'
				}));
			if (command === 'imslp_work_scores')
				return {
					files: editions,
					metadata: {
						catalogue: 'Op.49 No.1',
						key: 'G minor',
						compositionDate: '1797',
						instruments: 'piano',
						movements: '2 movements'
					},
					pageTitle: `${work} (Beethoven, Ludwig van)`
				};
			throw new Error(`Native action disabled in visual review: ${command}`);
		}
	}
});
mount(LibraryView, {
	target: document.getElementById('app')!,
	props: { onSelectScore: () => {} }
});
