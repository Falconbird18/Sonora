import { isTauri, invoke } from '@tauri-apps/api/core';
import type { Stroke } from '../types';
export type RecognitionMode = 'auto' | 'music' | 'text';
export type RecognitionProgress = {
	status: string;
	completed?: number | null;
	total?: number | null;
};
type Result = {
	kind: 'symbol' | 'text' | 'unknown';
	value: string;
	confidence?: number;
	inferenceMs: number;
};
let worker: Worker | undefined;
let initialization: Promise<void> | undefined;
let nextId = 0;
let progress: RecognitionProgress = { status: 'Loading built-in models…' };
const listeners = new Set<(update: RecognitionProgress) => void>();
const pending = new Map<
	number,
	{
		resolve: (result: Result) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}
>();
function fail(error: Error) {
	initialization = undefined;
	worker?.terminate();
	worker = undefined;
	for (const entry of pending.values()) {
		clearTimeout(entry.timer);
		entry.reject(error);
	}
	pending.clear();
}
export async function prepareRecognition(
	onProgress?: (update: RecognitionProgress) => void
) {
	if (onProgress) {
		listeners.add(onProgress);
		onProgress(progress);
	}
	try {
		initialization ??= new Promise<void>((resolve, reject) => {
			const nativeBackend = isTauri();
			const nativeReady = nativeBackend
				? invoke('prepare_handwriting_recognizer')
				: Promise.resolve();
			worker = new Worker(new URL('./handwriting.worker.ts', import.meta.url), {
				type: 'module'
			});
			const timer = setTimeout(() => {
				const error = new Error(
					'Could not prepare handwriting recognition. Please retry.'
				);
				fail(error);
				reject(error);
			}, 30000);
			worker.onmessage = (event) => {
				const message = event.data;
				if (message.type === 'progress') {
					progress = message;
					for (const listener of listeners) listener(progress);
				}
				if (message.type === 'ready')
					void nativeReady
						.then(() => {
							clearTimeout(timer);
							progress = { status: 'success' };
							for (const listener of listeners) listener(progress);
							resolve();
						})
						.catch(() => {});
				if (message.type === 'native-infer') {
					const target = worker;
					void invoke('recognize_handwriting_text', {
						input: Array.from(message.input as Float32Array),
						width: message.width
					})
						.then((result) =>
							target?.postMessage({
								type: 'native-result',
								id: message.id,
								result
							})
						)
						.catch((error) =>
							target?.postMessage({
								type: 'native-result',
								id: message.id,
								error: String(error)
							})
						);
				}
				if (message.type === 'init-error') {
					clearTimeout(timer);
					const error = new Error(message.error);
					fail(error);
					reject(error);
				}
				if (message.type === 'result' || message.type === 'error') {
					const entry = pending.get(message.id);
					if (!entry) return;
					pending.delete(message.id);
					clearTimeout(entry.timer);
					if (message.type === 'result') entry.resolve(message.result);
					else entry.reject(new Error(message.error));
				}
			};
			worker.onerror = () => {
				clearTimeout(timer);
				const error = new Error(
					'Handwriting engine stopped. Your ink is preserved; please retry.'
				);
				fail(error);
				reject(error);
			};
			void nativeReady.catch((error) => {
				clearTimeout(timer);
				const cause = new Error(
					`Could not prepare native handwriting: ${String(error)}`
				);
				fail(cause);
				reject(cause);
			});
			worker.postMessage({
				type: 'init',
				nativeBackend,
				base: new URL(`${import.meta.env.BASE_URL}handwriting/`, location.href)
					.href
			});
		});
		await initialization;
	} finally {
		if (onProgress) listeners.delete(onProgress);
	}
}
export async function recognizeInk(
	image: string,
	ink: Stroke[],
	mode: RecognitionMode = 'auto'
) {
	await prepareRecognition();
	return new Promise<Result>((resolve, reject) => {
		const id = ++nextId;
		const timer = setTimeout(() => {
			const error = new Error(
				'Recognition took too long. Your ink is preserved; please retry.'
			);
			fail(error);
			reject(error);
		}, 5000);
		pending.set(id, { resolve, reject, timer });
		worker!.postMessage({ type: 'recognize', id, image, ink, mode });
	});
}
