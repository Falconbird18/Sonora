import type { Stroke } from '../types';
export type MusicModel = {
	features: number;
	hidden: number;
	classes: string[];
	threshold: number;
};
const SIZE = 64;

/** A small feature classifier trained on isolated HOMUS pen symbols. */
export function musicFeatures(strokes: Stroke[]): Float32Array {
	const points = strokes.flatMap((s) => s.points);
	if (!points.length) throw Error('No ink');
	let left = Infinity,
		top = Infinity,
		right = -Infinity,
		bottom = -Infinity;
	for (const p of points) {
		left = Math.min(left, p.x);
		top = Math.min(top, p.y);
		right = Math.max(right, p.x);
		bottom = Math.max(bottom, p.y);
	}
	// Points are provided in page pixels, preserving the actual aspect ratio.
	const width = right - left,
		height = bottom - top,
		scale = 52 / Math.max(width, height, 1);
	const pixels = new Float32Array(4096);
	const draw = (x: number, y: number) => {
		for (let dy = -1; dy <= 1; dy++)
			for (let dx = -1; dx <= 1; dx++) {
				const px = Math.floor(x) + dx,
					py = Math.floor(y) + dy;
				if (px >= 0 && px < 64 && py >= 0 && py < 64) pixels[py * 64 + px] = 1;
			}
	};
	for (const s of strokes) {
		const pts = s.points.map((p) => ({
			x: (p.x - left) * scale + (64 - width * scale) / 2,
			y: (p.y - top) * scale + (64 - height * scale) / 2
		}));
		if (pts[0]) draw(pts[0].x, pts[0].y);
		for (let i = 1; i < pts.length; i++) {
			const a = pts[i - 1],
				b = pts[i],
				n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) * 2));
			for (let j = 0; j <= n; j++)
				draw(a.x + ((b.x - a.x) * j) / n, a.y + ((b.y - a.y) * j) / n);
		}
	}
	const blur = new Float32Array(4096),
		kernel = [0.1664, 0.6672, 0.1664];
	for (let y = 0; y < 64; y++)
		for (let x = 0; x < 64; x++) {
			let v = 0;
			for (let dy = -1; dy <= 1; dy++)
				for (let dx = -1; dx <= 1; dx++)
					v +=
						pixels[
							Math.max(0, Math.min(63, y + dy)) * 64 +
								Math.max(0, Math.min(63, x + dx))
						] *
						kernel[dx + 1] *
						kernel[dy + 1];
			blur[y * 64 + x] = v;
		}
	const result = new Float32Array(770);
	for (let y = 0; y < 64; y++)
		for (let x = 0; x < 64; x++) {
			const gx =
				(blur[y * 64 + Math.min(63, x + 1)] -
					blur[y * 64 + Math.max(0, x - 1)]) /
				(x === 0 || x === 63 ? 1 : 2);
			const gy =
				(blur[Math.min(63, y + 1) * 64 + x] -
					blur[Math.max(0, y - 1) * 64 + x]) /
				(y === 0 || y === 63 ? 1 : 2);
			const angle = ((Math.atan2(gy, gx) % Math.PI) + Math.PI) % Math.PI;
			const bin = Math.min(7, Math.floor((angle * 8) / Math.PI));
			result[(Math.floor(y / 8) * 8 + Math.floor(x / 8)) * 8 + bin] +=
				Math.hypot(gx, gy);
		}
	let norm = 1e-12;
	for (let i = 0; i < 512; i++) norm += result[i] * result[i];
	norm = Math.sqrt(norm);
	for (let i = 0; i < 512; i++) result[i] /= norm;
	for (let y = 0; y < 16; y++)
		for (let x = 0; x < 16; x++) {
			let v = 0;
			for (let dy = 0; dy < 4; dy++)
				for (let dx = 0; dx < 4; dx++)
					v += pixels[(y * 4 + dy) * 64 + x * 4 + dx];
			result[512 + y * 16 + x] = v / 16;
		}
	result[768] = Math.log((width + 1) / (height + 1));
	result[769] = Math.min(strokes.length, 20) / 10;
	return result;
}

export function classifyMusic(
	features: Float32Array,
	weights: Float32Array,
	model: MusicModel
) {
	const n = model.features,
		h = model.hidden,
		c = model.classes.length;
	const hidden = new Float32Array(h);
	const firstWeights = 2 * n,
		firstBias = firstWeights + n * h,
		secondWeights = firstBias + h,
		secondBias = secondWeights + h * c;
	for (let i = 0; i < h; i++) hidden[i] = weights[firstBias + i];
	for (let j = 0; j < n; j++) {
		const v = (features[j] - weights[j]) / weights[n + j];
		for (let i = 0; i < h; i++)
			hidden[i] += v * weights[firstWeights + j * h + i];
	}
	const scores = new Float32Array(c);
	for (let k = 0; k < c; k++) scores[k] = weights[secondBias + k];
	for (let i = 0; i < h; i++)
		if (hidden[i] > 0)
			for (let k = 0; k < c; k++)
				scores[k] += hidden[i] * weights[secondWeights + i * c + k];
	let best = 0;
	for (let k = 1; k < c; k++) if (scores[k] > scores[best]) best = k;
	let sum = 0;
	for (let k = 0; k < c; k++) sum += Math.exp(scores[k] - scores[best]);
	return { label: model.classes[best], confidence: 1 / sum };
}

export const musicSymbolIds: Record<string, string> = {
	'G-Clef': 'g-clef',
	'F-Clef': 'f-clef',
	'C-Clef': 'c-clef',
	'Whole-Note': 'whole-note',
	'Half-Note': 'half-note',
	'Quarter-Note': 'quarter-note',
	Sharp: 'sharp',
	Flat: 'flat',
	Natural: 'natural',
	'Double-Sharp': 'double-sharp',
	'Quarter-Rest': 'quarter-rest',
	'Eighth-Rest': 'eighth-rest',
	'Sixteenth-Rest': 'sixteenth-rest',
	'Thirty-Two-Rest': 'thirtysecond-rest',
	Dot: 'staccato'
};
