import Dexie from 'dexie';
import { MusicDatabase } from '../../src/lib/db';
import { plainScore } from '../../src/lib/scoreMeta';
import {
	remapLibrary,
	validateManifest,
	type LibraryManifest
} from '../../src/lib/libraryArchive';
const result = document.querySelector('#result')!;
function assert(value: unknown, message: string) {
	if (!value) throw Error(message);
}
const name = `Sonora-folder-regression-${crypto.randomUUID()}`;
const legacy = new Dexie(name);
legacy.version(10).stores({
	scores: 'id, title, composer, addedAt',
	annotations: 'id, scoreId, pageNum',
	folders: 'id, name, addedAt',
	lists: 'id, name, updatedAt',
	composerPortraits: 'id, fetchedAt',
	imslpThumbnails: 'url, fetchedAt'
});
let upgraded: MusicDatabase | undefined;
try {
	const base = { title: 'Sonata', composer: 'Bach', totalPages: 1, addedAt: 1 };
	await legacy.table('scores').bulkAdd([
		{
			...base,
			id: 'one',
			sourcePath: 'Bach/Parts/one.pdf',
			workTitle: 'Sonata',
			pdfBlob: new Blob(['pdf'])
		},
		{
			...base,
			id: 'two',
			sourcePath: 'Bach/two.pdf',
			workTitle: 'Sonata',
			edition: 'Part'
		},
		{ ...base, id: 'three', sourcePath: 'Mozart/three.pdf', composer: 'Mozart' }
	]);
	legacy.close();
	upgraded = new MusicDatabase(name);
	const rows = await upgraded.scores.toArray();
	const folders = await upgraded.libraryFolders.toArray();
	assert(
		folders.length === 3,
		'Filesystem parent directories must replace virtual work folders'
	);
	const one = rows.find((s) => s.id === 'one')!;
	const two = rows.find((s) => s.id === 'two')!;
	assert(
		one.folderId === 'disk:Bach/Parts',
		'Folder membership must follow the file path'
	);
	assert(
		two.folderId === 'disk:Bach',
		'Editions in different disk folders must stay separate'
	);
	assert(
		(await upgraded.libraryFolders.get('disk:Bach/Parts'))?.parentId ===
			'disk:Bach',
		'Nested disk hierarchy lost'
	);
	assert((await one.pdfBlob!.text()) === 'pdf', 'PDF content changed');
	assert(
		plainScore(one).sourcePath === 'Bach/Parts/one.pdf',
		'Score serialization lost filesystem path'
	);
	upgraded.close();
	await upgraded.open();
	assert(
		(await upgraded.scores.get('one'))?.folderId === 'disk:Bach/Parts',
		'Disk hierarchy did not persist'
	);
	const manifest: LibraryManifest = {
		format: 'sonora-library',
		version: 1,
		exportedAt: '',
		scores: [{ ...plainScore(two), folderId: 'child', pdf: 'two.pdf' }],
		annotations: [],
		lists: [],
		folders: [
			{ id: 'parent', name: 'Practice', parentId: '', createdAt: 1 },
			{ id: 'child', name: 'Sonata', parentId: 'parent', createdAt: 1 }
		]
	};
	const restored = remapLibrary(manifest, [
		{
			source_id: 'two',
			native_path: '/tmp/two.pdf',
			relative_path: 'Imported/Parts/two.pdf',
			size: 3,
			modified_at: 1
		}
	]);
	assert(
		restored.scores[0].folderId === 'disk:Imported/Parts',
		'Archive score folder not remapped'
	);
	assert(
		restored.folders[1].parentId === restored.folders[0].id,
		'Archive hierarchy not remapped'
	);
	let rejected = false;
	try {
		validateManifest({
			...manifest,
			folders: [{ id: 'a', name: 'Cycle', parentId: 'a' }]
		});
	} catch {
		rejected = true;
	}
	assert(rejected, 'Archive cycles accepted');
	result.textContent =
		'PASS: filesystem migration, PDF preservation, nested folders, persistence, serialization, archive disk hierarchy and cycle validation.';
} catch (error) {
	result.textContent = `FAIL: ${error instanceof Error ? error.stack : error}`;
} finally {
	legacy.close();
	upgraded?.close();
	await Dexie.delete(name);
}
