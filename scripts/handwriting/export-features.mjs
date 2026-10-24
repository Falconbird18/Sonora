import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
const [dataset, out = '/tmp/sonora-handwriting-training', hershey] =
	process.argv.slice(2);
if (!dataset || !hershey)
	throw Error(
		'Usage: node scripts/handwriting/export-features.mjs HOMUS_DIRECTORY OUTPUT_DIRECTORY HERSHEY_JSON'
	);
await mkdir(out, { recursive: true });
const project = fileURLToPath(new URL('../../', import.meta.url));
const server = await createServer({
	root: project,
	server: { middlewareMode: true, hmr: false, ws: false },
	appType: 'custom'
});
try {
	const { musicFeatures } = await server.ssrLoadModule(
		'/src/lib/recognition/musicClassifier.ts'
	);
	const meta = [],
		features = [],
		timings = [];
	for (let writer = 1; writer <= 100; writer++) {
		const dir = path.join(dataset, String(writer));
		for (const file of await readdir(dir)) {
			if (!file.endsWith('.txt')) continue;
			const lines = (await readFile(dir + '/' + file, 'utf8'))
				.trim()
				.split(/\r?\n/);
			const label = lines.shift().trim();
			const strokes = lines.map((line) => ({
				tool: 'pen',
				width: 3,
				color: '#000',
				points: line
					.split(';')
					.filter(Boolean)
					.map((p) => {
						const [x, y] = p.split(',').map(Number);
						return { x, y };
					})
			}));
			const start = performance.now();
			const f = musicFeatures(strokes);
			timings.push(performance.now() - start);
			meta.push({ writer, label });
			features.push(f);
		}
	}
	const fonts = Object.values(
		JSON.parse(await readFile(hershey, 'utf8')).fonts
	);
	let seed = 123456;
	const random = () => {
		seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
		return seed / 4294967296;
	};

	for (let i = 0; i < 5000; i++) {
		const font = fonts[i % fonts.length],
			letters = Object.keys(font.glyphs).filter((c) => /^[a-zA-Z]$/.test(c));
		let word = '';
		const length = i % 4 === 0 ? 1 : 2 + Math.floor(random() * 7);
		for (let k = 0; k < length; k++)
			word += letters[Math.floor(random() * letters.length)];
		let x = 0;
		const strokes = [];
		const shear = (random() - 0.5) * 0.4,
			scale = 40 / font.xHeight;
		for (const letter of word) {
			const glyph = font.glyphs[letter];
			for (const line of glyph.strokes)
				strokes.push({
					tool: 'pen',
					color: '#000',
					width: 3,
					points: line.map(([a, b]) => ({
						x: (x + a + b * shear) * scale,
						y: -b * scale
					}))
				});
			x += glyph.advance;
		}
		if (!strokes.length) {
			i--;
			continue;
		}
		meta.push({ writer: i < 4000 ? 0 : 101, label: 'Text' });
		features.push(musicFeatures(strokes));
	}
	const flat = new Float32Array(features.length * 770);
	features.forEach((f, i) => flat.set(f, i * 770));
	await writeFile(path.join(out, 'features.bin'), new Uint8Array(flat.buffer));
	await writeFile(path.join(out, 'samples.json'), JSON.stringify(meta));
	timings.sort((a, b) => a - b);
	console.log(
		JSON.stringify({
			samples: meta.length,
			feature_median_ms: timings[Math.floor(timings.length * 0.5)],
			feature_p95_ms: timings[Math.floor(timings.length * 0.95)]
		})
	);
} finally {
	await server.close();
}
