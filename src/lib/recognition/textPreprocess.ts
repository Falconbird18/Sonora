// Adapted from AccuScan, copyright 2026 Shashank Yadav, MIT.
// See public/handwriting/AccuScan-LICENSE.txt and MODEL-NOTICES.md.
/**
 * Image preprocessing, a line-for-line port of pipeline/src/accuscan/preprocess.py.
 * Both must agree to 1e-4 on shared/fixtures/preprocess.json.
 */

export const FEATURE_VERSION = 1;
export const INPUT_HEIGHT = 64;
export const MAX_WIDTH = 1024;
export const WIDTH_MULTIPLE = 4;
export const CROP_PADDING = 4;
export const MIN_CONTRAST = 24;
export const INK_THRESHOLD = 0.5;

export interface GrayImage {
	width: number;
	height: number;
	data: Uint8Array | Uint8ClampedArray;
}

export interface ModelInput {
	/** float32 [1, 1, 64, width], paper -1 and ink +1 */
	data: Float32Array;
	width: number;
	/** True when the line was wider than MAX_WIDTH and got squeezed horizontally. */
	squeezed: boolean;
}

export class EmptyImageError extends Error {
	constructor(message = 'no ink found') {
		super(message);
		this.name = 'EmptyImageError';
	}
}

/** Composite RGBA on white, then integer BT.601 grey (matches rgba_to_gray). */
export function rgbaToGray(
	rgba: Uint8Array | Uint8ClampedArray,
	width: number,
	height: number
): GrayImage {
	const out = new Uint8Array(width * height);
	for (let i = 0; i < width * height; i++) {
		const a = rgba[i * 4 + 3] ?? 0;
		const r = Math.floor(
			((rgba[i * 4] ?? 0) * a + 255 * (255 - a) + 127) / 255
		);
		const g = Math.floor(
			((rgba[i * 4 + 1] ?? 0) * a + 255 * (255 - a) + 127) / 255
		);
		const b = Math.floor(
			((rgba[i * 4 + 2] ?? 0) * a + 255 * (255 - a) + 127) / 255
		);
		out[i] = Math.floor((r * 299 + g * 587 + b * 114 + 500) / 1000);
	}
	return { width, height, data: out };
}

function orderStatistic(hist: Uint32Array, k: number): number {
	let cumulative = 0;
	for (let v = 0; v < 256; v++) {
		cumulative += hist[v] ?? 0;
		if (cumulative > k) return v;
	}
	return 255;
}

/** Paper -> 1, darkest ink -> 0, inverting light-on-dark input. */
export function normaliseContrast(img: GrayImage): Float64Array {
	const n = img.width * img.height;
	if (n === 0) throw new EmptyImageError('expected a non-empty image');
	const hist = new Uint32Array(256);
	for (let i = 0; i < n; i++) hist[img.data[i] ?? 0]! += 1;
	let median = orderStatistic(hist, Math.floor((n - 1) / 2));
	let lo = 0;
	while ((hist[lo] ?? 0) === 0) lo++;
	let hi = 255;
	while ((hist[hi] ?? 0) === 0) hi--;
	let invert = false;
	if (median - lo < hi - median) {
		invert = true;
		[median, lo] = [255 - median, 255 - hi];
	}
	const paper = median;
	const ink = lo;
	if (paper - ink < MIN_CONTRAST) throw new EmptyImageError();
	const out = new Float64Array(n);
	const range = paper - ink;
	for (let i = 0; i < n; i++) {
		const raw = img.data[i] ?? 0;
		const v = invert ? 255 - raw : raw;
		out[i] = Math.min(1, Math.max(0, (v - ink) / range));
	}
	return out;
}

export interface Bounds {
	top: number;
	bottom: number;
	left: number;
	right: number;
}

export function inkBounds(
	norm: Float64Array,
	width: number,
	height: number
): Bounds {
	let top = -1;
	let bottom = -1;
	let left = width;
	let right = -1;
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if ((norm[y * width + x] ?? 1) < INK_THRESHOLD) {
				if (top < 0) top = y;
				bottom = y;
				if (x < left) left = x;
				if (x > right) right = x;
			}
		}
	}
	if (top < 0) throw new EmptyImageError();
	return { top, bottom, left, right };
}

/** Dense (dst x src) antialiased triangle weights, rows summing to 1. */
export function resampleWeights(src: number, dst: number): Float64Array[] {
	const scale = src / dst;
	const support = Math.max(scale, 1);
	const rows: Float64Array[] = [];
	for (let i = 0; i < dst; i++) {
		const centre = (i + 0.5) * scale;
		const row = new Float64Array(src);
		let sum = 0;
		const from = Math.max(0, Math.floor(centre - support - 1));
		const to = Math.min(src, Math.ceil(centre + support + 1));
		for (let j = from; j < to; j++) {
			const w = Math.max(0, 1 - Math.abs(j + 0.5 - centre) / support);
			row[j] = w;
			sum += w;
		}
		for (let j = from; j < to; j++) row[j] = (row[j] ?? 0) / sum;
		rows.push(row);
	}
	return rows;
}

export function targetWidth(height: number, width: number): number {
	const scaled = Math.floor((width * INPUT_HEIGHT) / height + 0.5);
	return Math.min(MAX_WIDTH, Math.max(1, scaled));
}

export function paddedWidth(width: number): number {
	return Math.max(
		WIDTH_MULTIPLE,
		Math.ceil(width / WIDTH_MULTIPLE) * WIDTH_MULTIPLE
	);
}

/** Greyscale image -> model input. Throws EmptyImageError when there is no ink. */
export function preprocess(img: GrayImage): ModelInput {
	const norm = normaliseContrast(img);
	const { top, bottom, left, right } = inkBounds(norm, img.width, img.height);
	const pad = CROP_PADDING;
	const h = bottom - top + 1 + 2 * pad;
	const w = right - left + 1 + 2 * pad;
	const crop = new Float64Array(h * w).fill(1);
	for (let y = 0; y < h; y++) {
		const sy = top - pad + y;
		if (sy < 0 || sy >= img.height) continue;
		for (let x = 0; x < w; x++) {
			const sx = left - pad + x;
			if (sx < 0 || sx >= img.width) continue;
			crop[y * w + x] = norm[sy * img.width + sx] ?? 1;
		}
	}
	const unclamped = Math.floor((w * INPUT_HEIGHT) / h + 0.5);
	const newW = targetWidth(h, w);
	const wy = resampleWeights(h, INPUT_HEIGHT);
	const wx = resampleWeights(w, newW);

	// Vertical pass: [64, w], then horizontal: [64, newW]. Only non-zero taps are visited.
	const vertical = new Float64Array(INPUT_HEIGHT * w);
	for (let i = 0; i < INPUT_HEIGHT; i++) {
		const row = wy[i]!;
		for (let j = 0; j < h; j++) {
			const weight = row[j] ?? 0;
			if (weight === 0) continue;
			for (let x = 0; x < w; x++) {
				vertical[i * w + x] =
					(vertical[i * w + x] ?? 0) + weight * (crop[j * w + x] ?? 1);
			}
		}
	}
	const outW = paddedWidth(newW);
	const data = new Float32Array(INPUT_HEIGHT * outW).fill(-1);
	for (let k = 0; k < newW; k++) {
		const row = wx[k]!;
		let from = 0;
		while (from < w && (row[from] ?? 0) === 0) from++;
		let to = w;
		while (to > from && (row[to - 1] ?? 0) === 0) to--;
		for (let i = 0; i < INPUT_HEIGHT; i++) {
			let acc = 0;
			for (let j = from; j < to; j++)
				acc += (row[j] ?? 0) * (vertical[i * w + j] ?? 1);
			data[i * outW + k] = 1 - 2 * acc;
		}
	}
	return { data, width: outW, squeezed: unclamped > MAX_WIDTH };
}
