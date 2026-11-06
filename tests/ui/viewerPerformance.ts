import { mount, unmount, tick } from 'svelte';
import ScoreViewer from '../../src/lib/ScoreViewer.svelte';
import { settings } from '../../src/lib/settingsStore';
import { makePdfFixture } from './pdfFixture';
import { warmPdfRenderer } from '../../src/lib/pdfUtils';
import '../../src/app.css';
if (!import.meta.env.DEV) throw Error('Development-only fixture');
const app = document.querySelector<HTMLElement>('#app')!;
const result = document.querySelector('#result')!;
const delay = (ms = 10) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
let phase = 'first paint';
async function waitFor(test: () => boolean) {
	const start = performance.now();
	while (!test()) {
		const error = app.querySelector('.error')?.textContent;
		if (error) throw Error(error);
		if (performance.now() - start > 10000)
			throw Error(`Viewer regression timed out: ${phase}`);
		await delay();
	}
}
let component: ReturnType<typeof mount> | undefined;
try {
	settings.update((value) => ({
		...value,
		autoLayout: false,
		dualPages: false,
		keepAwake: false
	}));
	await warmPdfRenderer();
	const bytes = await makePdfFixture('scan');
	const start = performance.now();
	const score = {
		id: `viewer-benchmark-${Date.now()}`,
		title: 'Benchmark',
		composer: 'Fixture',
		totalPages: 24,
		addedAt: 1,
		pdfBlob: new Blob([bytes])
	};
	const open = () =>
		mount(ScoreViewer, {
			target: app,
			props: { score, onClose() {} }
		});
	component = open();
	await waitFor(
		() =>
			!app.querySelector('.loading') &&
			(app.querySelector<HTMLCanvasElement>('.pdf-canvas')?.width ?? 0) > 300
	);
	const firstPaintMs = performance.now() - start;
	function assertPage(number: number, index = 0) {
		const canvas =
			app.querySelectorAll<HTMLCanvasElement>('.pdf-canvas')[index];
		const actual = canvas
			.getContext('2d')!
			.getImageData(
				Math.floor((canvas.width * 10) / 612),
				Math.floor((canvas.height * 10) / 792),
				1,
				1
			).data[0];
		const expected = Math.round((number / 25) * 255);
		if (Math.abs(actual - expected) > 2)
			throw Error(
				`Expected page ${number} in slot ${index}, got marker ${actual} (expected ${expected})`
			);
	}
	assertPage(1);
	// Let nearby page prefetch settle, then measure a real next/previous navigation.
	await delay(600);
	const turn = async (label: string) => {
		const start = performance.now();
		app
			.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
			.click();
		await tick();
		await waitFor(() => !app.querySelector('.pages.transitioning'));
		return +(performance.now() - start).toFixed(2);
	};
	const nextMs = await turn('Next page');
	assertPage(2);
	const previousMs = await turn('Previous page');
	assertPage(1);
	for (let i = 0; i < 8; i++) {
		app
			.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!
			.click();
		await tick();
	}
	await delay(500);
	await waitFor(() => !app.querySelector('.pages.transitioning'));
	if (
		app.querySelector<HTMLInputElement>('input[aria-label="Page number"]')
			?.value !== '9'
	)
		throw Error('Rapid navigation lost page state');
	assertPage(9);
	phase = 'zoom';
	const beforeZoom = app.querySelector<HTMLCanvasElement>('.pdf-canvas')!.width;
	app.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click();
	await waitFor(
		() =>
			app.querySelector<HTMLCanvasElement>('.pdf-canvas')!.width > beforeZoom
	);
	phase = 'dual';
	app
		.querySelector<HTMLButtonElement>(
			'button[aria-label="Switch to two pages"]'
		)!
		.click();
	await waitFor(
		() =>
			app.querySelectorAll('.pdf-canvas').length === 2 &&
			[...app.querySelectorAll<HTMLCanvasElement>('.pdf-canvas')].every(
				(canvas) => canvas.width > 300
			)
	);
	await delay(350);
	assertPage(9);
	assertPage(10, 1);
	const beforeResize =
		app.querySelector<HTMLCanvasElement>('.pdf-canvas')!.height;
	// Resize must render at new dimensions rather than reuse a stale layout cache key.
	phase = 'resize';
	app.style.height = '450px';
	app.style.width = '900px';
	window.dispatchEvent(new Event('resize'));
	await delay(350);
	await waitFor(
		() =>
			app.querySelector<HTMLCanvasElement>('.pdf-canvas')!.height < beforeResize
	);
	phase = 'final spread';
	const pageInput = app.querySelector<HTMLInputElement>(
		'input[aria-label="Page number"]'
	)!;
	pageInput.value = '23';
	pageInput.dispatchEvent(new Event('input', { bubbles: true }));
	pageInput.dispatchEvent(
		new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
	);
	await tick();
	await delay(500);
	assertPage(23);
	assertPage(24, 1);
	if (
		!app.querySelector<HTMLButtonElement>('button[aria-label="Next page"]')!
			.disabled
	)
		throw Error('Final spread must not repeat its last page');
	await turn('Previous page');
	assertPage(21);
	assertPage(22, 1);
	const canvas = app.querySelector<HTMLCanvasElement>('.pdf-canvas')!;
	const pixels = canvas
		.getContext('2d')!
		.getImageData(0, 0, canvas.width, canvas.height).data;
	if (!pixels.some((value, index) => index % 4 !== 3 && value < 100))
		throw Error('Page bitmap is blank');
	phase = 'reopen saved even page';
	await unmount(component);
	component = undefined;
	settings.update((value) => ({ ...value, dualPages: true }));
	localStorage.setItem(
		`sonora-viewer-${score.id}`,
		JSON.stringify({ page: 24 })
	);
	component = open();
	await waitFor(
		() =>
			app.querySelectorAll<HTMLCanvasElement>('.pdf-canvas').length === 2 &&
			[...app.querySelectorAll<HTMLCanvasElement>('.pdf-canvas')].every(
				(canvas) => canvas.width > 300
			)
	);
	assertPage(23);
	assertPage(24, 1);
	if (
		app.querySelector<HTMLInputElement>('input[aria-label="Page number"]')!
			.value !== '23'
	)
		throw Error('Restored page must use consistent spread boundaries');
	await turn('Previous page');
	assertPage(21);
	assertPage(22, 1);
	result.textContent = JSON.stringify(
		{
			status: 'PASS',
			firstPaintMs: +firstPaintMs.toFixed(2),
			nextMs,
			previousMs,
			checks: [
				'cached turns',
				'rapid navigation',
				'zoom resolution',
				'dual spread',
				'resized bitmap',
				'nonblank page',
				'final spread navigation',
				'reopen saved even page'
			]
		},
		null,
		2
	);
} catch (error) {
	result.textContent = JSON.stringify(
		{
			status: 'FAIL',
			error: String(error),
			diagnostics: {
				workspaceWidth:
					app.querySelector<HTMLElement>('.workspace')?.clientWidth,
				canvases: [
					...app.querySelectorAll<HTMLCanvasElement>('.pdf-canvas')
				].map((canvas) => ({ width: canvas.width, height: canvas.height })),
				dualControl:
					app
						.querySelector('button[aria-label="Switch to single page"]')
						?.getAttribute('aria-label') ?? 'single page'
			}
		},
		null,
		2
	);
	throw error;
} finally {
	if (component) await unmount(component);
}
