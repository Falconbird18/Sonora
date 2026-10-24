import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createServer } from 'vite';
const server = await createServer({
	server: { middlewareMode: true, hmr: false, ws: false },
	appType: 'custom'
});
try {
	const { musicFeatures, classifyMusic } = await server.ssrLoadModule(
		'/src/lib/recognition/musicClassifier.ts'
	);
	const metadata = JSON.parse(
		await readFile('public/handwriting/music-mlp.json', 'utf8')
	);
	const bytes = await readFile('public/handwriting/music-mlp.bin');
	assert.equal(
		createHash('sha256').update(bytes).digest('hex'),
		metadata.sha256,
		'Model checksum'
	);
	const expectedFloats =
		metadata.features * (2 + metadata.hidden) +
		metadata.hidden * (1 + metadata.classes.length) +
		metadata.classes.length;
	assert.equal(bytes.byteLength, expectedFloats * 4, 'Weight layout');
	const weights = new Float32Array(
		bytes.buffer,
		bytes.byteOffset,
		bytes.byteLength / 4
	);
	const fixture = JSON.parse(
		await readFile('tests/fixtures/handwriting-feature-parity.json', 'utf8')
	);
	const features = musicFeatures(fixture.ink);
	assert.equal(features.length, metadata.features);
	for (let i = 0; i < features.length; i++)
		assert.ok(
			Math.abs(features[i] - fixture.features[i]) < 1e-5,
			`Feature parity at ${i}`
		);
	const actual = classifyMusic(features, weights, metadata);
	assert.equal(actual.label, fixture.label, 'Numpy/TypeScript model parity');
	assert.ok(
		Math.abs(actual.confidence - fixture.confidence) < 1e-5,
		'Confidence parity'
	);
	assert.throws(() => musicFeatures([]), 'Blank ink must not be classified');
	const times = [];
	for (let i = 0; i < 30; i++) {
		const start = performance.now();
		classifyMusic(musicFeatures(fixture.ink), weights, metadata);
		times.push(performance.now() - start);
	}
	times.sort((a, b) => a - b);
	console.log(
		JSON.stringify({
			status: 'PASS',
			modelBytes: bytes.byteLength,
			symbol: 'sharp',
			medianMs: +times[15].toFixed(2),
			p95Ms: +times[28].toFixed(2)
		})
	);
} finally {
	await server.close();
}
