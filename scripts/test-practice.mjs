import assert from 'node:assert/strict';
import { createServer } from 'vite';
const server = await createServer({
	server: { middlewareMode: true, hmr: false, ws: false },
	appType: 'custom'
});
try {
	const { suggestFilename } = await server.ssrLoadModule(
		'/src/lib/scoreImport.ts'
	);
	for (const name of [
		'IMSLP109823898_Beethoven_Sonata_Op.27_No.2.pdf',
		'Beethoven-Sonata_Op.27_No.2-IMSLP109823898.pdf',
		'Beethoven, Ludwig van_Sonata_Op.27_No.2.pdf'
	]) {
		const result = suggestFilename(name);
		assert.equal(result.title, 'Sonata Op.27 No.2', name);
		assert.equal(result.composer, 'Ludwig van Beethoven');
		assert.equal(result.catalogue, 'Op.27 No.2');
		assert.equal(result.composerCountry, 'Germany / Austria');
	}
	assert.equal(
		suggestFilename(
			'IMSLP123456.pdf',
			'Johann Sebastian Bach\nGoldberg Variations\nIMSLP123456'
		).title,
		'Goldberg Variations'
	);
	assert.equal(suggestFilename('IMSLP123456.pdf').title, 'Untitled score');
	assert.equal(
		suggestFilename('PMLP123-456_Concerto_B-flat_major.pdf').title,
		'Concerto B flat major'
	);
	assert.equal(
		suggestFilename('Unknown_Composer_New_Work.pdf').composer,
		'Unknown Composer'
	);
	assert.equal(
		suggestFilename('Sonata_No.12_Op.26.pdf').title,
		'Sonata No.12 Op.26'
	);
	const { replaceLayerMarks, recoverLayers } = await server.ssrLoadModule(
		'/src/lib/annotationLayers.ts'
	);
	const legacy = { id: 'legacy' },
		a = { id: 'a', layerId: 'practice' },
		b = { id: 'b', layerId: 'teacher' };
	assert.deepEqual(replaceLayerMarks([legacy, a, b], [], 'practice'), [
		legacy,
		b
	]);
	assert.deepEqual(
		replaceLayerMarks(
			[legacy, a, b],
			[{ id: 'restored', layerId: 'practice' }],
			'practice'
		),
		[legacy, b, { id: 'restored', layerId: 'practice' }]
	);
	assert.deepEqual(replaceLayerMarks([legacy, a, b], [], 'default'), [a, b]);
	assert.deepEqual(
		recoverLayers(undefined, [legacy, a, b]).map((l) => l.id),
		['default', 'practice', 'teacher']
	);
	const layers = [
		{ id: 'teacher', name: 'Teacher', visible: false },
		{ id: 'default', name: 'Annotations', visible: true }
	];
	assert.deepEqual(recoverLayers(layers, [legacy, b]), layers);
	const { plainScore } = await server.ssrLoadModule('/src/lib/scoreMeta.ts');
	const { portableScore, remapLibrary } = await server.ssrLoadModule(
		'/src/lib/libraryArchive.ts'
	);
	const score = plainScore({
		id: 'test',
		title: 'Sonata',
		composer: 'Composer',
		addedAt: 1,
		totalPages: 1,
		annotationLayers: layers,
		contentHash: 'abcd'
	});
	assert.deepEqual(score.annotationLayers, layers);
	assert.equal(score.contentHash, 'abcd');
	assert.deepEqual(portableScore(score, 0).annotationLayers, layers);
	const { detectFrequency, describePitch } =
		await server.ssrLoadModule('/src/lib/pitch.ts');
	for (const sampleRate of [44100, 48000])
		for (const frequency of [
			55, 82.4069, 110, 196, 261.6256, 440, 880, 1318.51
		]) {
			const samples = Float32Array.from(
				{ length: 4096 },
				(_, i) =>
					0.2 * Math.sin((2 * Math.PI * frequency * i) / sampleRate) +
					0.06 * Math.sin((4 * Math.PI * frequency * i) / sampleRate)
			);
			const detected = detectFrequency(samples, sampleRate);
			assert.ok(detected, `No pitch at ${frequency}`);
			assert.ok(
				Math.abs(1200 * Math.log2(detected / frequency)) < 3,
				`${frequency}Hz detected as ${detected}`
			);
		}
	assert.equal(detectFrequency(new Float32Array(4096), 48000), null);
	assert.deepEqual(describePitch(440), { note: 'A4', cents: 0 });
	assert.deepEqual(describePitch(442, 442), { note: 'A4', cents: 0 });
	assert.equal(describePitch(440 * 2 ** (20 / 1200)).cents, 20);
	console.log(
		'Practice regression checks passed: filename cleanup, composer tagging, layer migration, isolated undo, archive metadata, and tuner pitch accuracy.'
	);
} finally {
	await server.close();
}
