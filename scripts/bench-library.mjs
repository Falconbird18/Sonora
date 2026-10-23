import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { cpus } from 'node:os';
import { writeFileSync } from 'node:fs';
import { createServer } from 'vite';
const args = process.argv.slice(2);
const refIndex = args.indexOf('--ref');
const reference = refIndex >= 0 ? args[refIndex + 1] : undefined;
if (refIndex >= 0) args.splice(refIndex, 2);
const sourceCommit = execFileSync('git', ['rev-parse', reference || 'HEAD'], {
	encoding: 'utf8'
}).trim();
const originals = new Map();
if (reference)
	for (const name of ['works.ts', 'composerDatabase.ts', 'scoreImport.ts']) {
		originals.set(
			`/src/lib/${name}`,
			execFileSync('git', ['show', `${sourceCommit}:src/lib/${name}`], {
				encoding: 'utf8'
			})
		);
	}
const server = await createServer({
	plugins: [
		{
			name: 'benchmark-reference',
			enforce: 'pre',
			load(id) {
				for (const [suffix, source] of originals)
					if (id.endsWith(suffix)) return source;
			}
		}
	],
	server: { middlewareMode: true, hmr: false, ws: false },
	appType: 'custom'
});
const rows = [];
function measure(name, size, fn) {
	fn();
	const samples = [];
	for (let i = 0; i < 7; i++) {
		const start = performance.now();
		fn();
		samples.push(performance.now() - start);
	}
	samples.sort((a, b) => a - b);
	rows.push({
		name,
		size,
		medianMs: +samples[3].toFixed(3),
		p95Ms: +samples[6].toFixed(3)
	});
}
try {
	const { groupWorks, repairMetadata, createRepairContext } =
		await server.ssrLoadModule('/src/lib/works.ts');
	const { suggestFilename } = await server.ssrLoadModule(
		'/src/lib/scoreImport.ts'
	);
	const { createMoveMatcher: indexedMatcher } = await server.ssrLoadModule(
		'/src/lib/fileIdentity.ts'
	);
	const createMoveMatcher = reference
		? (removed) => {
				const claimed = new Set();
				return (size, modified) => {
					const match = removed.find(
						(row) =>
							!claimed.has(row.id) &&
							row.fileSize === size &&
							row.fileModifiedAt === modified
					);
					if (match) claimed.add(match.id);
					return match;
				};
			}
		: indexedMatcher;
	const { createLibraryQuery } = await server.ssrLoadModule(
		'/src/lib/libraryQuery.ts'
	);
	const { COMPOSERS } = await server.ssrLoadModule(
		'/src/lib/composerDatabase.ts'
	);
	for (const size of (process.env.SONORA_BENCH_SIZES || '1000,10000,50000').split(',').map(Number)) {
		if (!Number.isInteger(size) || size < 1) throw Error('Benchmark sizes must be positive integers');
		const scores = Array.from({ length: size }, (_, i) => ({
			id: String(i),
			title: `Sonata ${i % 400} (${i + 2})`,
			composer: COMPOSERS[i % COMPOSERS.length].name,
			totalPages: 20,
			addedAt: i,
			fileSize: i,
			fileModifiedAt: i,
			tags: ['Piano', 'Romantic']
		}));
		measure('groupWorks', size, () => groupWorks(scores));
		if (!reference) {
			const query = createLibraryQuery(scores);
			measure('searchWarm', size, () => {
				for (const search of ['s', 'so', 'son', 'sona', 'sonata 32', 'piano'])
					query({ search, composer: '', filter: 'all', sort: 'title' });
			});
			measure('searchCold', size, () =>
				createLibraryQuery(scores)({
					search: 'piano',
					composer: '',
					filter: 'all',
					sort: 'title'
				})
			);
		}
		measure('metadataRepair', size, () => {
			const context = createRepairContext?.(scores);
			for (const score of scores) repairMetadata(score, scores, context);
		});
		measure('renameMatching', size, () => {
			const match = createMoveMatcher(scores);
			for (let i = size - 1; i >= 0; i--) match(i, i);
		});
	}
	for (const size of [100, 1000])
		measure('filenameSuggestions', size, () => {
			for (let i = 0; i < size; i++)
				suggestFilename(
					`${COMPOSERS[i % COMPOSERS.length].name} - Sonata ${i}.pdf`,
					'Music for piano'
				);
		});
	const result = {
		timestamp: new Date().toISOString(),
		sourceCommit,
		reference: reference || null,
		node: process.version,
		cpu: cpus()[0]?.model,
		samples: 7,
		rows
	};
	console.table(rows);
	const output = args[0];
	if (output) writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
} finally {
	await server.close();
}
