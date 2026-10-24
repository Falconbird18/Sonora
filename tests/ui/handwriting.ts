import { mount, tick, unmount } from 'svelte';
import ScoreViewer from '../../src/lib/ScoreViewer.svelte';
import { settings } from '../../src/lib/settingsStore';
import { DEFAULT_HANDWRITING_PAUSE_MS } from '../../src/lib/handwriting';
import { db } from '../../src/lib/db';
import { makePdfFixture } from './pdfFixture';
import '../../src/app.css';
if (!import.meta.env.DEV) throw Error('Development-only fixture');
localStorage.setItem(
	'sonora-handwriting-pause-ms',
	String(DEFAULT_HANDWRITING_PAUSE_MS)
);
const app = document.querySelector<HTMLElement>('#app')!;
const output = document.querySelector('#result')!;
const delay = (ms = 30) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(test: () => boolean) {
	const start = Date.now();
	while (!test()) {
		if (Date.now() - start > 12000)
			throw Error('Timed out: ' + app.textContent!.slice(-600));
		await delay();
	}
}
function assert(value: unknown, message: string) {
	if (!value) throw Error(message);
}
let response = { kind: 'symbol', value: 'sharp' };
let calls = 0;
let slow = false;
const preview = new URLSearchParams(location.search).has('preview');
const BrowserWorker = window.Worker;
class RecognitionWorkerFixture {
	onmessage: ((event: { data: unknown }) => void) | null = null;
	onerror: (() => void) | null = null;
	terminated = false;
	terminate() {
		this.terminated = true;
	}
	postMessage(request: { type: string; id: number }) {
		if (request.type === 'init') {
			setTimeout(
				() =>
					this.onmessage?.({
						data: {
							type: 'progress',
							status: 'Loading built-in models',
							completed: 63,
							total: 100
						}
					}),
				20
			);
			setTimeout(() => this.onmessage?.({ data: { type: 'ready' } }), 60);
		}
		if (request.type === 'recognize') {
			calls++;
			const value = { ...response, inferenceMs: 1 };
			setTimeout(
				() => {
					if (!this.terminated)
						this.onmessage?.({
							data: { type: 'result', id: request.id, result: value }
						});
				},
				slow ? 1500 : 20
			);
		}
	}
}
window.Worker = function (url: string | URL, options?: WorkerOptions) {
	if (String(url).includes('handwriting.worker'))
		return new RecognitionWorkerFixture();
	return new BrowserWorker(url, options);
} as unknown as typeof Worker;
const id = `handwriting-test-${Date.now()}`;
let component: ReturnType<typeof mount> | undefined;
async function saved() {
	await delay(250);
	return db.annotations.get(`${id}:1`);
}
function button(label: string) {
	const el = app.querySelector<HTMLButtonElement>(
		`button[aria-label="${label}"]`
	);
	if (!el) throw Error(`Missing ${label}`);
	el.click();
}
function stroke(canvas: HTMLCanvasElement, x = 0.3, pointerType = 'mouse') {
	const rect = canvas.getBoundingClientRect();
	for (const [type, dx, dy, buttons] of [
		['pointerdown', 0, 0, 1],
		['pointermove', 12, 25, 1],
		['pointerup', 12, 25, 0]
	] as const) {
		canvas.dispatchEvent(
			new PointerEvent(type, {
				bubbles: true,
				pointerId: 1,
				pointerType,
				button: 0,
				buttons,
				clientX: rect.left + rect.width * x + dx,
				clientY: rect.top + rect.height * 0.3 + dy
			})
		);
	}
}
try {
	settings.update((s) => ({
		...s,
		autoLayout: false,
		dualPages: false,
		keepAwake: false
	}));
	const bytes = await makePdfFixture('scan');
	component = mount(ScoreViewer, {
		target: app,
		props: {
			score: {
				id,
				title: 'Handwriting',
				composer: 'Fixture',
				totalPages: 24,
				addedAt: 1,
				pdfBlob: new Blob([bytes])
			},
			onClose() {}
		}
	});
	await waitFor(
		() =>
			!app.querySelector('.loading') &&
			(app.querySelector<HTMLCanvasElement>('.pdf-canvas')?.width ?? 0) > 300
	);
	button('Annotation tools');
	await tick();
	button('Handwriting');
	await tick();

	[...app.querySelectorAll<HTMLButtonElement>('button')]
		.find((b) => b.textContent === 'Model setup')!
		.click();
	await waitFor(() => !!app.querySelector('dialog[open]'));
	if (preview) {
		output.remove();
		await new Promise(() => {});
	}
	await waitFor(
		() => app.querySelector<HTMLProgressElement>('progress')?.value === 100
	);
	assert(
		!app.textContent!.includes('Ollama'),
		'Setup must not require a model server'
	);
	assert(!app.querySelector('.rail-label'), 'Toolbar must be icon-only');
	[...app.querySelectorAll<HTMLButtonElement>('dialog button')]
		.find((b) => b.textContent!.includes('Start writing'))!
		.click();
	await tick();
	const canvas = app.querySelector<HTMLCanvasElement>('.ink-canvas')!;
	stroke(canvas, 0.3, 'touch');
	await delay(1100);
	assert(calls === 0, 'Touch must not write');
	stroke(canvas);
	await waitFor(() => app.textContent!.includes('Converted.'));
	let record = await saved();
	assert(
		record?.stamps.length === 1 && record.strokes.length === 0,
		'Sharp conversion'
	);
	button('Undo');
	record = await saved();
	assert(
		record?.stamps.length === 0 && record.strokes.length === 1,
		'First undo restores ink'
	);
	button('Undo');
	record = await saved();
	assert(record?.strokes.length === 0, 'Second undo removes stroke');
	button('Redo');
	button('Redo');
	record = await saved();
	assert(record?.stamps.length === 1, 'Redo conversion');
	response = { kind: 'text', value: 'dolce' };
	stroke(canvas, 0.6);
	await waitFor(() => app.textContent!.includes('Converted.'));
	await delay(DEFAULT_HANDWRITING_PAUSE_MS + 250);
	record = await saved();
	assert(record?.notes[0]?.text === 'dolce', 'Handwriting text conversion');
	response = { kind: 'text', value: 'T' };
	const beforeT = calls;
	stroke(canvas, 0.75);
	await delay(1200);
	assert(calls === beforeT, 'Do not submit during a short break');
	record = await saved();
	assert(
		(record?.strokes[0]?.points.length ?? 0) >= 2,
		'Capture stroke movement even without coalesced events'
	);
	stroke(canvas, 0.75);
	await delay(1200);
	assert(calls === beforeT, 'Second stroke restarts the full pause');
	await waitFor(() => calls === beforeT + 1);
	await delay(300);
	record = await saved();
	assert(
		record?.notes.at(-1)?.text === 'T' && record.strokes.length === 0,
		'Convert both strokes as one annotation'
	);
	button('Undo');
	record = await saved();
	assert(record?.strokes.length === 2, 'Undo conversion restores both strokes');
	button('Redo');
	await saved();

	response = { kind: 'text', value: 'word' };
	const beforeWord = calls;
	for (let i = 0; i < 4; i++) {
		stroke(canvas, 0.4 + i * 0.03);
		await delay(750);
		assert(calls === beforeWord, 'Ignore every short pause throughout a word');
	}
	await waitFor(() => calls === beforeWord + 1);
	await delay(300);
	record = await saved();
	assert(
		record?.notes.at(-1)?.text === 'word' && record.strokes.length === 0,
		'Convert a complete word together'
	);

	response = { kind: 'unknown', value: '' };
	stroke(canvas, 0.9);
	await waitFor(() => app.textContent!.includes('Retry conversion'));
	record = await saved();
	assert(
		record?.strokes.length === 1,
		'Unknown result preserves ink for retry'
	);
	response = { kind: 'text', value: 'retry' };
	[...app.querySelectorAll<HTMLButtonElement>('button')]
		.find((b) => b.textContent?.trim() === 'Retry conversion')!
		.click();
	await waitFor(
		() =>
			!app.textContent!.includes('Retry conversion') &&
			app.textContent!.includes('Converted.')
	);
	record = await saved();
	assert(
		record?.notes.at(-1)?.text === 'retry' && record.strokes.length === 0,
		'Retry converts preserved strokes without duplication'
	);

	slow = true;
	stroke(canvas, 0.8);
	const before = calls;
	await waitFor(() => calls > before);
	button('Undo');
	await delay(1800);
	record = await saved();
	assert(
		record?.notes.length === 4 && record.strokes.length === 0,
		'Undo invalidates in-flight recognition'
	);
	output.textContent =
		'PASS: built-in model preparation, icon-only rail, touch rejection, symbol/text conversion, multi-stroke pause grouping, two-step undo, redo, stale result protection';
} catch (error) {
	output.textContent = `FAIL: ${String(error)}`;
	console.error(error);
} finally {
	if (component) await unmount(component);
	await db.annotations.where('scoreId').equals(id).delete();
}
