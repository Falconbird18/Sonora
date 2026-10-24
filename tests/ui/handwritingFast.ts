import {
	prepareRecognition,
	recognizeInk
} from '../../src/lib/recognition/client';
import type { Stroke } from '../../src/lib/types';
if (!import.meta.env.DEV) throw Error('Development-only fixture');
const output = document.querySelector('#result')!;
const stroke = (points: Array<[number, number]>): Stroke => ({
	tool: 'pen',
	color: '#000',
	width: 3,
	points: points.map(([x, y]) => ({ x, y }))
});
async function image(name: string) {
	const bytes = new Uint8Array(
		await (
			await fetch(`/tests/ui/handwriting-fixtures/${name}.png`)
		).arrayBuffer()
	);
	let raw = '';
	for (const b of bytes) raw += String.fromCharCode(b);
	return btoa(raw);
}
try {
	const start = performance.now();
	await prepareRecognition();
	const loadMs = performance.now() - start;
	const rows = [];
	for (const [name, expected, ink] of [
		['hello-world', 'hello world', []],
		['thank-you', 'Thank you!', []],
		[
			't',
			'T',
			[
				stroke([
					[40, 44],
					[200, 44]
				]),
				stroke([
					[120, 44],
					[120, 200]
				])
			]
		]
	] as Array<[string, string, Stroke[]]>) {
		const png = await image(name);
		const times = [];
		let result;
		for (let i = 0; i < 6; i++) {
			const start = performance.now();
			result = await recognizeInk(
				png,
				ink,
				name === 'thank-you' ? 'text' : 'auto'
			);
			times.push(performance.now() - start);
		}
		times.sort((a, b) => a - b);
		rows.push({
			sample: name,
			prediction: result!.value,
			expected,
			medianMs: +times[3].toFixed(2),
			maxMs: +times.at(-1)!.toFixed(2)
		});
	}
	const sharp = [
		stroke([
			[80, 40],
			[80, 190]
		]),
		stroke([
			[140, 35],
			[140, 185]
		]),
		stroke([
			[40, 90],
			[180, 80]
		]),
		stroke([
			[40, 145],
			[180, 135]
		])
	];
	const sharpResult = await recognizeInk(await image('t'), sharp, 'music');
	rows.push({ sample: 'sharp strokes', ...sharpResult });
	const allCorrect =
		sharpResult.kind === 'symbol' &&
		sharpResult.value === 'sharp' &&
		rows
			.slice(0, 3)
			.every((row) => 'expected' in row && row.prediction === row.expected);
	output.textContent = JSON.stringify(
		{ status: allCorrect ? 'PASS' : 'FAIL', loadMs: +loadMs.toFixed(2), rows },
		null,
		2
	);
} catch (error) {
	output.textContent = `FAIL: ${String(error)}`;
	console.error(error);
}
