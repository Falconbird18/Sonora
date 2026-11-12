import { mount, unmount, tick } from 'svelte';
import ScoreViewer from '../../src/lib/ScoreViewer.svelte';
import { settings } from '../../src/lib/settingsStore';
import { makePdfFixture, readPdfFixturePage } from './pdfFixture';
import { warmPdfRenderer } from '../../src/lib/pdfUtils';
import '../../src/app.css';
if (!import.meta.env.DEV) throw Error('Development-only fixture');
const app = document.querySelector<HTMLElement>('#app')!;
const result = document.querySelector('#result')!;
const delay = (ms = 10) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
let phase = 'first paint';
let lastRenderedPages: number[] = [];
const scoreId = `viewer-benchmark-${Date.now()}`;
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
function supportsSyntheticTouch(target: HTMLElement) {
	try {
		const touch = new Touch({ identifier: 1, target });
		new TouchEvent('touchstart', { touches: [touch] });
		return true;
	} catch {
		return false;
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
	const pageCount = 25;
	const bytes = await makePdfFixture('scan', pageCount);
	const start = performance.now();
	component = mount(ScoreViewer, {
		target: app,
		props: {
			score: {
				id: scoreId,
				title: 'Benchmark',
				composer: 'Fixture',
				totalPages: pageCount,
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
	phase = 'tap navigation';
	const tap = async (label: string, pointerType: string) => {
		const button = app.querySelector<HTMLButtonElement>(
			`button.page-hit[aria-label="${label}"]`
		)!;
		const rect = button.getBoundingClientRect();
		const options = {
			bubbles: true,
			cancelable: true,
			pointerId: 101,
			pointerType,
			button: 0,
			clientX: rect.left + rect.width / 2,
			clientY: rect.top + rect.height / 2
		};
		button.dispatchEvent(
			new PointerEvent('pointerdown', { ...options, buttons: 1 })
		);
		button.dispatchEvent(
			new PointerEvent('pointerup', { ...options, buttons: 0 })
		);
		// Some platforms also synthesize click after pointerup: it must not double-turn.
		button.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
		await tick();
		await waitFor(() => !app.querySelector('.pages.transitioning'));
	};
	await tap('Next page', 'touch');
	if (
		app.querySelector<HTMLInputElement>('input[aria-label="Page number"]')
			?.value !== '10'
	)
		throw Error('Touch tap must advance exactly one page');
	await tap('Previous page', 'mouse');
	if (
		app.querySelector<HTMLInputElement>('input[aria-label="Page number"]')
			?.value !== '9'
	)
		throw Error('Mouse edge click must go back exactly one page');

	phase = 'zoom';
	const beforeZoom = app.querySelector<HTMLCanvasElement>('.pdf-canvas')!.width;
	app.querySelector<HTMLButtonElement>('button[aria-label="Zoom in"]')!.click();
	await waitFor(
		() =>
			app.querySelector<HTMLCanvasElement>('.pdf-canvas')!.width > beforeZoom
	);
	const pageInput = app.querySelector<HTMLInputElement>(
		'input[aria-label="Page number"]'
	)!;
	const jump = (number: number) => {
		pageInput.value = String(number);
		pageInput.dispatchEvent(new Event('input', { bubbles: true }));
		pageInput.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
		);
	};
	const renderedPages = () =>
		[
			...app.querySelectorAll<HTMLCanvasElement>(
				'.page-shell:not([hidden]) .pdf-canvas'
			)
		]
			.sort(
				(a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left
			)
			.map(readPdfFixturePage);
	const expectPages = async (...numbers: number[]) => {
		await tick();
		await waitFor(() => {
			lastRenderedPages = renderedPages();
			return lastRenderedPages.join(',') === numbers.join(',');
		});
	};
	const toggleLayout = (label: string) =>
		app
			.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!
			.click();

	phase = 'even page through layout changes';
	jump(10);
	await expectPages(10);
	toggleLayout('Switch to two pages');
	await expectPages(9, 10);
	toggleLayout('Switch to single page');
	await expectPages(10);
	if (pageInput.value !== '10') throw Error('Layout change lost the selected page');

	phase = 'spread turns from an even page';
	toggleLayout('Switch to two pages');
	await expectPages(9, 10);
	await turn('Next page');
	await expectPages(11, 12);
	await turn('Previous page');
	await expectPages(9, 10);
	jump(pageCount - 1);
	await expectPages(pageCount - 2, pageCount - 1);
	if (Number(pageInput.value) !== pageCount - 1)
		throw Error('Jump lost the selected page');
	await turn('Next page');
	await expectPages(pageCount);
	if (Number(pageInput.value) !== pageCount)
		throw Error('Turn skipped the final unpaired page');
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight' }));
	await expectPages(pageCount);
	if (Number(pageInput.value) !== pageCount)
		throw Error('Turn advanced past the last spread');
	await turn('Previous page');
	await expectPages(pageCount - 2, pageCount - 1);
	jump(2);
	await expectPages(1, 2);
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
	await expectPages(1, 2);
	if (Number(pageInput.value) !== 2)
		throw Error('Turn advanced before the first spread');

	phase = 'rapid two-page turns';
	const nextSpread = app.querySelector<HTMLButtonElement>(
		'.page-controls button[aria-label="Next page"]'
	)!;
	const observed = [renderedPages().join(',')];
	nextSpread.click();
	nextSpread.click();
	nextSpread.click();
	const turnDeadline = performance.now() + 5000;
	while (observed.at(-1) !== '7,8' && performance.now() < turnDeadline) {
		await new Promise(requestAnimationFrame);
		const spread = renderedPages().join(',');
		if (spread !== observed.at(-1)) observed.push(spread);
	}
	if (observed.join(' → ') !== '1,2 → 3,4 → 5,6 → 7,8')
		throw Error(`Rapid turns displayed ${observed.join(' → ')}`);

	phase = 'held page-turn key';
	window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft' }));
	for (let i = 0; i < 3; i++)
		window.dispatchEvent(
			new KeyboardEvent('keydown', { key: 'ArrowLeft', repeat: true })
		);
	await expectPages(5, 6);

	phase = 'dual';
	jump(10);
	await expectPages(9, 10);
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
	const workspace = app.querySelector<HTMLElement>('.workspace')!;
	const syntheticTouch = supportsSyntheticTouch(workspace);
	if (syntheticTouch) {
		phase = 'touchscreen pinch';
		const pages = app.querySelector<HTMLElement>('.pages')!;
		const rect = workspace.getBoundingClientRect();
		const initialWidth =
			app.querySelector<HTMLCanvasElement>('.pdf-canvas')!.width;
		const finger = (identifier: number, x: number) =>
			new Touch({
				identifier,
				target: workspace,
				clientX: rect.left + x,
				clientY: rect.top + 180
			});
		const dispatchTouch = (type: string, touches: Touch[]) =>
			workspace.dispatchEvent(
				new TouchEvent(type, {
					bubbles: true,
					cancelable: true,
					touches,
					targetTouches: touches
				})
			);
		dispatchTouch('touchstart', [finger(1, 200), finger(2, 400)]);
		dispatchTouch('touchmove', [finger(2, 450), finger(1, 150)]);
		await delay(50);
		const pinched = new DOMMatrix(getComputedStyle(pages).transform);
		if (pinched.a < 1.5) throw Error('Touchscreen pinch did not scale page');
		// Holding a pinch must not swap out canvas backing storage under the fingers.
		await delay(350);
		if (
			app.querySelector<HTMLCanvasElement>('.pdf-canvas')!.width !== initialWidth
		)
			throw Error('Bitmap changed during active pinch');
		dispatchTouch('touchend', []);
		await waitFor(
			() =>
				app.querySelector<HTMLCanvasElement>('.pdf-canvas')!.width > initialWidth
		);
		const settled = new DOMMatrix(getComputedStyle(pages).transform);
		if (
			Math.abs(settled.a - pinched.a) > 0.001 ||
			Math.abs(settled.e - pinched.e) > 0.1
		)
			throw Error('Sharpening shifted touchscreen viewport');
	}

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
				'touch and mouse page taps without duplicate turns',
				'rapid navigation',
				'zoom resolution',
				'ordered spread rasters, rapid turns, held keys, and layout changes',
				'resized bitmap',
				'nonblank page',
				...(syntheticTouch ? ['touchscreen pinch and stable sharpening'] : [])
			],
			skipped: syntheticTouch ? [] : ['synthetic touchscreen pinch unsupported']
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
				pageNumber: app.querySelector<HTMLInputElement>(
					'input[aria-label="Page number"]'
				)?.value,
				lastRenderedPages,
				savedPage: JSON.parse(
					localStorage.getItem(`sonora-viewer-${scoreId}`) ?? '{}'
				).page,
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
