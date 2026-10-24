/// <reference lib="webworker" />
import * as ort from 'onnxruntime-web/wasm';
import wasmUrl from 'onnxruntime-web/ort-wasm-simd-threaded.wasm?url';
import { preprocess, rgbaToGray } from './textPreprocess';
import {
	classifyMusic,
	musicFeatures,
	musicSymbolIds,
	type MusicModel
} from './musicClassifier';
import type { Stroke } from '../types';

declare const self: DedicatedWorkerGlobalScope;
let session: ort.InferenceSession;
let nativeBackend = false;
let nativeId = 0;
const nativePending = new Map<
	number,
	{
		resolve: (value: { text: string; confidence: number }) => void;
		reject: (error: Error) => void;
	}
>();
let model: MusicModel;
let weights: Float32Array;
let initialization: Promise<void> | undefined;
const post = (value: unknown) => self.postMessage(value);
async function initialize(base: string) {
	ort.env.wasm.numThreads = 1;
	ort.env.wasm.wasmPaths = { wasm: wasmUrl };
	const urls = nativeBackend
		? ['music-mlp.json', 'music-mlp.bin']
		: ['music-mlp.json', 'music-mlp.bin', 'text-int8.onnx'];
	let completed = 0;
	const responses = await Promise.all(urls.map((name) => fetch(base + name)));
	if (responses.some((r) => !r.ok))
		throw Error(
			'Could not load built-in recognition models. Restart Sonora and try again.'
		);
	const total = responses.reduce(
		(n, r) => n + Number(r.headers.get('Content-Length') ?? 0),
		0
	);
	const parts = await Promise.all(
		responses.map(async (response) => {
			const data = await response.arrayBuffer();
			completed += data.byteLength;
			post({
				type: 'progress',
				status: 'Loading built-in models',
				completed,
				total: total || undefined
			});
			return data;
		})
	);
	model = JSON.parse(new TextDecoder().decode(parts[0]));
	weights = new Float32Array(parts[1]);
	const expected =
		model.features * (2 + model.hidden) +
		model.hidden * (1 + model.classes.length) +
		model.classes.length;
	if (model.features !== 770 || weights.length !== expected)
		throw Error(
			'The built-in music model is damaged. Please reinstall Sonora.'
		);

	post({ type: 'progress', status: 'Preparing handwriting recognition…' });
	if (nativeBackend) {
		post({ type: 'ready' });
		return;
	}
	session = await ort.InferenceSession.create(new Uint8Array(parts[2]), {
		executionProviders: ['wasm']
	});
	// Warm up before accepting ink, keeping first-word latency out of the writing flow.
	const input = new ort.Tensor(
		'float32',
		new Float32Array(64 * 128).fill(-1),
		[1, 1, 64, 128]
	);
	const output = await session.run({ image: input });
	input.dispose();
	for (const tensor of Object.values(output)) tensor.dispose();
	post({ type: 'ready' });
}

/** Plain, two-line capital T. Resolves a common I/T ambiguity in word OCR. */
function capitalT(strokes: Stroke[]) {
	if (strokes.length !== 2 || strokes.some((s) => s.points.length < 2))
		return false;
	const lines = strokes.map((s) => {
		const a = s.points[0],
			b = s.points.at(-1)!;
		let length = 0;
		for (let i = 1; i < s.points.length; i++)
			length += Math.hypot(
				s.points[i].x - s.points[i - 1].x,
				s.points[i].y - s.points[i - 1].y
			);
		return {
			a,
			b,
			dx: Math.abs(b.x - a.x),
			dy: Math.abs(b.y - a.y),
			straight: Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, length) > 0.9
		};
	});
	const horizontal = lines.find((l) => l.straight && l.dx > l.dy * 4),
		vertical = lines.find((l) => l.straight && l.dy > l.dx * 4);
	if (
		!horizontal ||
		!vertical ||
		horizontal === vertical ||
		horizontal.dx < vertical.dy * 0.35
	)
		return false;
	const cx = (horizontal.a.x + horizontal.b.x) / 2,
		cy = (horizontal.a.y + horizontal.b.y) / 2,
		vx = (vertical.a.x + vertical.b.x) / 2,
		top = Math.min(vertical.a.y, vertical.b.y);
	return (
		Math.abs(cx - vx) < horizontal.dx * 0.2 &&
		Math.abs(cy - top) < vertical.dy * 0.15
	);
}

/** Two crossbars crossing both stems: the canonical four-stroke sharp. */
function canonicalSharp(strokes: Stroke[]) {
	if (strokes.length !== 4) return false;
	const lines = strokes
		.map((s) => {
			if (s.points.length < 2) return null;
			const a = s.points[0],
				b = s.points.at(-1)!;
			let length = 0;
			for (let i = 1; i < s.points.length; i++)
				length += Math.hypot(
					s.points[i].x - s.points[i - 1].x,
					s.points[i].y - s.points[i - 1].y
				);
			return {
				a,
				b,
				dx: Math.abs(b.x - a.x),
				dy: Math.abs(b.y - a.y),
				straight: Math.hypot(b.x - a.x, b.y - a.y) / Math.max(1, length) > 0.9
			};
		})
		.filter((l) => l?.straight);
	const vertical = lines.filter((l) => l!.dy > l!.dx * 4),
		horizontal = lines.filter((l) => l!.dx > l!.dy * 2.5);
	if (vertical.length !== 2 || horizontal.length !== 2) return false;
	const xs = vertical.map((l) => (l!.a.x + l!.b.x) / 2),
		ys = horizontal.map((l) => (l!.a.y + l!.b.y) / 2);
	return (
		horizontal.every(
			(l) =>
				Math.min(l!.a.x, l!.b.x) < Math.min(...xs) &&
				Math.max(l!.a.x, l!.b.x) > Math.max(...xs)
		) &&
		vertical.every(
			(l) =>
				Math.min(l!.a.y, l!.b.y) < Math.min(...ys) &&
				Math.max(l!.a.y, l!.b.y) > Math.max(...ys)
		) &&
		Math.abs(xs[0] - xs[1]) > 3 &&
		Math.abs(ys[0] - ys[1]) > 3
	);
}

async function recognize(
	image: string,
	ink: Stroke[],
	mode: 'auto' | 'music' | 'text'
) {
	const started = performance.now();
	if (mode !== 'music' && capitalT(ink))
		return {
			kind: 'text',
			value: 'T',
			inferenceMs: performance.now() - started
		};
	if (mode !== 'text' && canonicalSharp(ink))
		return {
			kind: 'symbol',
			value: 'sharp',
			confidence: 1,
			inferenceMs: performance.now() - started
		};
	const symbol =
		ink.length && mode !== 'text'
			? classifyMusic(musicFeatures(ink), weights, model)
			: null;
	const mapped = symbol ? musicSymbolIds[symbol.label] : undefined;
	if (mode === 'music')
		return symbol && mapped && symbol.confidence >= model.threshold
			? {
					kind: 'symbol',
					value: mapped,
					confidence: symbol.confidence,
					inferenceMs: performance.now() - started
				}
			: {
					kind: 'unknown',
					value: '',
					inferenceMs: performance.now() - started
				};
	const bytes = Uint8Array.from(atob(image), (c) => c.charCodeAt(0));
	const bitmap = await createImageBitmap(
		new Blob([bytes], { type: 'image/png' })
	);
	const canvas = new OffscreenCanvas(bitmap.width, bitmap.height),
		ctx = canvas.getContext('2d');
	if (!ctx) throw Error('Handwriting image processing unavailable.');
	ctx.drawImage(bitmap, 0, 0);
	bitmap.close();
	const rgba = ctx.getImageData(0, 0, canvas.width, canvas.height);
	const input = preprocess(rgbaToGray(rgba.data, canvas.width, canvas.height));
	let text = '',
		confidence = 0;
	if (nativeBackend) {
		const result = await new Promise<{ text: string; confidence: number }>(
			(resolve, reject) => {
				const id = ++nativeId;
				nativePending.set(id, { resolve, reject });
				self.postMessage(
					{ type: 'native-infer', id, input: input.data, width: input.width },
					[input.data.buffer]
				);
			}
		);
		text = result.text;
		confidence = result.confidence;
	} else {
		const tensor = new ort.Tensor('float32', input.data, [
			1,
			1,
			64,
			input.width
		]);
		let previous = -1;
		const confidences: number[] = [];
		const output = await session.run({ image: tensor });
		try {
			const logits = output.log_probs.data as Float32Array;
			const frames = output.log_probs.dims[0];
			for (let frame = 0; frame < frames; frame++) {
				let best = 0;
				for (let c = 1; c < 96; c++)
					if (logits[frame * 96 + c] > logits[frame * 96 + best]) best = c;
				const p = Math.exp(logits[frame * 96 + best]);
				if (best !== 0 && best !== previous) {
					text += String.fromCharCode(best + 31);
					confidences.push(p);
				} else if (best !== 0 && best === previous)
					confidences[confidences.length - 1] = Math.max(
						confidences.at(-1) ?? 0,
						p
					);
				previous = best;
			}
		} finally {
			tensor.dispose();
			for (const value of Object.values(output)) value.dispose();
		}
		confidence = confidences.length
			? confidences.reduce((sum, p) => sum + p, 0) / confidences.length
			: 0;
	}
	text = text.trim();
	const dynamics = ['p', 'pp', 'mp', 'mf', 'f', 'ff', 'fff', 'sfz'];
	const aliases: Record<string, string> = {
		'#': 'sharp',
		'♯': 'sharp',
		'♭': 'flat',
		'♮': 'natural',
		'>': 'accent',
		'^': 'marcato',
		tr: 'trill',
		',': 'breath',
		'//': 'caesura',
		V: 'up-bow',
		bb: 'double-flat'
	};
	if (mode === 'auto' && confidence >= 0.85) {
		const id = dynamics.includes(text)
			? text
			: (aliases[text] ??
				(/^[0-5]$/.test(text) ? `finger-${text}` : undefined));
		if (id)
			return {
				kind: 'symbol',
				value: id,
				confidence,
				inferenceMs: performance.now() - started
			};
	}
	const legibleWord =
		text.length > 1 && /[A-Za-z]/.test(text) && confidence >= 0.85;
	const points = ink.flatMap((s) => s.points);
	const bounds = points.reduce(
		(b, p) => ({
			left: Math.min(b.left, p.x),
			right: Math.max(b.right, p.x),
			top: Math.min(b.top, p.y),
			bottom: Math.max(b.bottom, p.y)
		}),
		{ left: Infinity, right: -Infinity, top: Infinity, bottom: -Infinity }
	);
	const tinyDot =
		symbol?.label === 'Dot' &&
		points.length > 0 &&
		bounds.right - bounds.left < 12 &&
		bounds.bottom - bounds.top < 12;
	if (
		mode === 'auto' &&
		!legibleWord &&
		symbol &&
		mapped &&
		symbol.confidence >= model.threshold &&
		(symbol.label !== 'Dot' || tinyDot)
	)
		return {
			kind: 'symbol',
			value: mapped,
			confidence: symbol.confidence,
			inferenceMs: performance.now() - started
		};
	const allowText = mode === 'text' || legibleWord || /^[A-Za-z]$/.test(text);

	return {
		kind: text && confidence >= 0.85 && allowText ? 'text' : 'unknown',
		value: text,
		confidence,
		inferenceMs: performance.now() - started
	};
}
let queue: Promise<unknown> = Promise.resolve();
self.onmessage = (event: MessageEvent) => {
	const request = event.data;
	if (request.type === 'native-result') {
		const entry = nativePending.get(request.id);
		if (entry) {
			nativePending.delete(request.id);
			if (request.error) entry.reject(new Error(request.error));
			else entry.resolve(request.result);
		}
		return;
	}
	if (request.type === 'init') {
		nativeBackend = !!request.nativeBackend;
		initialization ??= initialize(request.base).catch((error) => {
			initialization = undefined;
			throw error;
		});
		void initialization.catch((error) =>
			post({ type: 'init-error', error: String(error) })
		);
		return;
	}
	if (request.type === 'recognize')
		queue = queue
			.catch(() => undefined)
			.then(async () => {
				try {
					await initialization;
					const result = await recognize(
						request.image,
						request.ink,
						request.mode
					);
					post({ type: 'result', id: request.id, result });
				} catch (error) {
					post({ type: 'error', id: request.id, error: String(error) });
				}
			});
};
