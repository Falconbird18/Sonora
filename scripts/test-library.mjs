import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({
	server: { middlewareMode: true, hmr: false, ws: false },
	appType: 'custom'
});
try {
	const { groupWorks, repairMetadata } =
		await server.ssrLoadModule('/src/lib/works.ts');
	const { formatComposer } = await server.ssrLoadModule(
		'/src/lib/composerDisplay.ts'
	);
	const { parseWorkTitle } = await server.ssrLoadModule('/src/lib/imslp.ts');
	const { plainScore } = await server.ssrLoadModule('/src/lib/scoreMeta.ts');
	const base = {
		id: '1',
		title: 'Symphony No.9',
		composer: 'Ludwig van Beethoven',
		workTitle: 'Symphony No.9',
		totalPages: 40,
		addedAt: 1
	};
	const part = { ...base, id: '2', edition: 'Violin I', workId: 'imslp:123' };
	assert.equal(groupWorks([base, part]).length, 1);
	assert.equal(groupWorks([base, part])[0].scores.length, 2);
	assert.equal(
		groupWorks([base, { ...part, composer: 'Antonín Dvořák' }]).length,
		2
	);
	assert.equal(
		formatComposer(base.composer, 'surname-first'),
		'Beethoven, Ludwig van'
	);
	assert.equal(formatComposer(base.composer, 'initials'), 'L. van Beethoven');
	assert.equal(
		formatComposer('Bach, Johann Sebastian', 'full'),
		'Johann Sebastian Bach'
	);
	assert.equal(
		parseWorkTitle('Sonata (early version) (Bach, Johann Sebastian)').title,
		'Sonata (early version)'
	);
	assert.equal(
		parseWorkTitle('Sonata without composer').composer,
		'Unknown Composer'
	);
	assert.deepEqual(
		repairMetadata({ ...base, metadataEdited: true }, [base]),
		{}
	);
	assert.equal(
		plainScore({ ...part, publisher: 'Henle', metadataEdited: true }).publisher,
		'Henle'
	);
	assert.equal(
		plainScore({ ...part, publisher: 'Henle', metadataEdited: true })
			.metadataEdited,
		true
	);
	const { reorderEntries } = await server.ssrLoadModule('/src/lib/lists.ts');
	const entries = [
		{ id: 'a', scoreId: '1' },
		{ id: 'b', scoreId: '2' },
		{ id: 'c', scoreId: '1' }
	];
	assert.deepEqual(
		reorderEntries(entries, 'a', 2).map((e) => e.id),
		['b', 'c', 'a']
	);
	assert.deepEqual(
		entries.map((e) => e.id),
		['a', 'b', 'c']
	);
	assert.deepEqual(
		reorderEntries(entries, 'b', 0).map((e) => e.id),
		['b', 'a', 'c']
	);
	const { portableScore, remapLibrary, validateManifest } =
		await server.ssrLoadModule('/src/lib/libraryArchive.ts');
	const portable = portableScore(
		{
			...base,
			nativePath: '/private/library/score.pdf',
			pdfUrl: 'asset://private',
			thumbnailUrl: 'data:image/png;base64,example'
		},
		0
	);
	assert.equal(portable.nativePath, undefined);
	assert.equal(portable.pdfUrl, undefined);
	assert.equal(portable.thumbnailUrl, undefined);
	const note = {
		id: 'note',
		text: 'Dolce',
		x: 12,
		y: 30,
		fontSize: 18,
		color: '#123456'
	};
	const manifest = {
		format: 'sonora-library',
		version: 1,
		exportedAt: new Date().toISOString(),
		scores: [portable],
		annotations: [
			{
				id: '1:1',
				scoreId: '1',
				pageNum: 1,
				notes: [note],
				stamps: [],
				strokes: [
					{
						id: 'pen',
						tool: 'pen',
						color: '#112233',
						width: 2,
						points: [{ x: 2, y: 3, pressure: 0.8 }]
					}
				]
			}
		],
		lists: [
			{
				id: 'concert',
				name: 'Recital',
				description: 'In order',
				entries: [entries[0], entries[2]],
				createdAt: 1,
				updatedAt: 2
			}
		]
	};
	validateManifest(manifest);
	const restored = remapLibrary(manifest, [
		{
			source_id: '1',
			native_path: '/new/import/score.pdf',
			relative_path: 'Shared/score.pdf',
			size: 1000,
			modified_at: 10
		}
	]);
	assert.equal(restored.annotations[0].id, 'library-root:Shared/score.pdf:1');
	assert.equal(restored.annotations[0].notes[0].text, 'Dolce');
	assert.equal(restored.annotations[0].strokes[0].points[0].pressure, 0.8);
	assert.equal(restored.lists[0].entries.length, 2);
	assert.ok(
		restored.lists[0].entries.every(
			(entry) => entry.scoreId === restored.scores[0].id
		)
	);
	assert.throws(
		() => validateManifest({ ...manifest, version: 100 }),
		/Unsupported/
	);

	console.log(
		'Library regression checks passed: grouping, composer presentation, title parsing, edit protection, metadata persistence.'
	);
} finally {
	await server.close();
}
