import {
	prepareRecognition,
	recognizeInk,
	type RecognitionMode
} from './recognition/client';
import { MUSIC_SYMBOLS } from './musicSymbols';
import type { Stroke } from './types';

/** Rasterize only the new ink; score pages never enter the recognizer. */
export function handwritingImage(
	strokes: Stroke[],
	pageWidth: number,
	pageHeight: number
) {
	const points = strokes.flatMap((s) => s.points);
	if (!points.length) throw new Error('No handwriting to recognize.');
	const bounds = points.reduce(
		(b, p) => ({
			left: Math.min(b.left, p.x),
			top: Math.min(b.top, p.y),
			right: Math.max(b.right, p.x),
			bottom: Math.max(b.bottom, p.y)
		}),
		{ left: 1, top: 1, right: 0, bottom: 0 }
	);
	const x = bounds.left,
		y = bounds.top;
	const width = Math.max(1 / pageWidth, bounds.right - x);
	const height = Math.max(1 / pageHeight, bounds.bottom - y);
	const scale = Math.min(
		3,
		960 / Math.max(width * pageWidth, height * pageHeight)
	);
	const canvas = document.createElement('canvas');
	canvas.width = Math.ceil(width * pageWidth * scale) + 48;
	canvas.height = Math.ceil(height * pageHeight * scale) + 48;
	const ctx = canvas.getContext('2d');
	if (!ctx) throw new Error('Handwriting canvas unavailable.');
	ctx.fillStyle = 'white';
	ctx.fillRect(0, 0, canvas.width, canvas.height);
	ctx.strokeStyle = 'black';
	ctx.lineCap = 'round';
	ctx.lineJoin = 'round';
	for (const stroke of strokes) {
		ctx.lineWidth = Math.max(2, stroke.width * scale);
		ctx.beginPath();
		stroke.points.forEach((p, i) => {
			const px = 24 + (p.x - x) * pageWidth * scale;
			const py = 24 + (p.y - y) * pageHeight * scale;
			if (i === 0) {
				ctx.moveTo(px, py);
				ctx.lineTo(px + 0.1, py);
			} else ctx.lineTo(px, py);
		});
		ctx.stroke();
	}
	return {
		image: canvas.toDataURL('image/png').split(',')[1],
		ink: strokes.map((s) => ({
			...s,
			points: s.points.map((p) => ({
				...p,
				x: p.x * pageWidth,
				y: p.y * pageHeight
			}))
		})),
		x,
		y,
		width,
		height
	};
}

export async function recognizeHandwriting(
	image: string,
	ink: Stroke[] = [],
	mode: RecognitionMode = 'auto'
) {
	const result = await recognizeInk(image, ink, mode);
	if (result.kind === 'symbol') {
		const symbol = MUSIC_SYMBOLS.find((s) => s.id === result.value);
		if (symbol) return { kind: 'symbol' as const, symbol };
	}
	if (
		result.kind === 'text' &&
		result.value.trim() &&
		result.value.length <= 2000
	)
		return { kind: 'text' as const, text: result.value.trim() };
	return null;
}
export type ModelPreparationProgress = {
	status: string;
	completed?: number | null;
	total?: number | null;
};
export const prepareHandwritingModels = prepareRecognition;

export const DEFAULT_HANDWRITING_PAUSE_MS = 2000;
export function loadHandwritingPause() {
	try {
		const saved = Number(localStorage.getItem('sonora-handwriting-pause-ms'));
		return saved >= 1000 && saved <= 5000
			? saved
			: DEFAULT_HANDWRITING_PAUSE_MS;
	} catch {
		return DEFAULT_HANDWRITING_PAUSE_MS;
	}
}
