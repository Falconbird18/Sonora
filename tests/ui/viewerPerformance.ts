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
	component = mount(ScoreViewer, {
		target: app,
		props: {
			score: {
				id: `viewer-benchmark-${Date.now()}`,
				title: 'Benchmark',
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
	const firstPaintMs = performance.now() - start;
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
	const previousMs = await turn('Previous page');
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
	const canvas = app.querySelector<HTMLCanvasElement>('.pdf-canvas')!;
	const pixels = canvas
		.getContext('2d')!
		.getImageData(0, 0, canvas.width, canvas.height).data;
	if (!pixels.some((value, index) => index % 4 !== 3 && value < 100))
		throw Error('Page bitmap is blank');
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
				'nonblank page'
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
