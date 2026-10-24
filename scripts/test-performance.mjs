import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({
	server: { middlewareMode: true, hmr: false, ws: false },
	appType: 'custom'
});
try {
	const { createMoveMatcher } = await server.ssrLoadModule(
		'/src/lib/fileIdentity.ts'
	);
	const { createRepairContext, repairMetadata } =
		await server.ssrLoadModule('/src/lib/works.ts');
	const { createLibraryQuery } = await server.ssrLoadModule(
		'/src/lib/libraryQuery.ts'
	);
	const scores = Array.from({ length: 1000 }, (_, i) => ({
		id: String(i),
		title: `Sonata ${i % 40}${i % 3 ? '' : ' (2)'}`,
		composer: i % 2 ? 'Johann Sebastian Bach' : 'Unknown Composer',
		addedAt: i,
		totalPages: 1,
		fileSize: i % 7,
		fileModifiedAt: i % 11,
		favorite: i % 3 === 0,
		lastOpenedAt: i % 5 ? 0 : i,
		tags: ['piano', 'Romantic'],
		edition: i % 2 ? 'Henle' : undefined
	}));
	const claimed = new Set();
	const match = createMoveMatcher(scores);
	for (const score of [...scores].reverse()) {
		const expected = scores.find(
			(row) =>
				!claimed.has(row.id) &&
				row.fileSize === score.fileSize &&
				row.fileModifiedAt === score.fileModifiedAt
		);
		assert.equal(match(score.fileSize, score.fileModifiedAt)?.id, expected?.id);
		if (expected) claimed.add(expected.id);
	}
	assert.equal(match(-1, 0), undefined);
	const context = createRepairContext(scores);
	for (const score of scores)
		assert.deepEqual(
			repairMetadata(score, scores, context),
			repairMetadata(score, scores)
		);
	const query = createLibraryQuery(scores);
	for (const search of [
		'',
		'sonata 1',
		' PIANO ',
		'henle',
		'missing',
		'unknown'
	])
		for (const composer of ['', 'Johann Sebastian Bach'])
			for (const filter of ['all', 'favorites', 'recent'])
				for (const sort of ['title', 'composer', 'recent']) {
					const q = search.trim().toLowerCase();
					const expected = scores
						.filter(
							(score) =>
								(!composer || score.composer === composer) &&
								(filter === 'all' ||
									(filter === 'favorites'
										? score.favorite
										: score.lastOpenedAt)) &&
								(!q ||
									[
										score.title,
										score.composer,
										score.workTitle,
										score.edition,
										score.catalogue,
										score.key,
										score.instruments,
										score.publisher,
										score.editor,
										...score.tags
									].some((value) => value?.toLowerCase().includes(q)))
						)
						.sort((a, b) =>
							sort === 'title'
								? a.title.localeCompare(b.title)
								: sort === 'composer'
									? a.composer.localeCompare(b.composer) ||
										a.title.localeCompare(b.title)
									: (b.lastOpenedAt || b.addedAt) -
										(a.lastOpenedAt || a.addedAt)
						);
					assert.deepEqual(
						query({ search, composer, filter, sort }).map((s) => s.id),
						expected.map((s) => s.id)
					);
				}
	console.log(
		'Performance regression checks passed: consumed duplicate identities, metadata parity, search/filter/sort parity.'
	);
} finally {
	await server.close();
}
