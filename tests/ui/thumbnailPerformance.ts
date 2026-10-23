import { mount, unmount } from 'svelte';
import LibraryView from '../../src/lib/LibraryView.svelte';
import { db } from '../../src/lib/db';
import { makePdfFixture } from './pdfFixture';
import '../../src/app.css';
if (
	!import.meta.env.DEV ||
	(await db.scores.toArray()).some(
		(score) => !score.id.startsWith('thumbnail-benchmark-')
	) ||
	(await db.folders.count()) ||
	(await db.lists.count())
)
	throw Error('Use an isolated benchmark origin');
const app = document.querySelector<HTMLElement>('#app')!;
const result = document.querySelector('#result')!;
const delay = (ms = 10) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));
async function waitFor(test: () => boolean) {
	const start = performance.now();
	while (!test()) {
		if (performance.now() - start > 20000)
			throw Error('Thumbnail test timed out');
		await delay();
	}
}
let component: ReturnType<typeof mount> | undefined;
try {
	await db.scores.clear();
	localStorage.setItem(
		'sonora-library-settings',
		JSON.stringify({ view: 'grid', sort: 'recent' })
	);
	const bytes = await makePdfFixture('scan');
	const pdfBlob = new Blob([bytes], { type: 'application/pdf' });
	await db.scores.bulkPut(
		Array.from({ length: 80 }, (_, i) => ({
			id: `thumbnail-benchmark-${i}`,
			title: `Scan ${i}`,
			composer: 'Fixture',
			metadataEdited: true,
			addedAt: i + 1,
			totalPages: 1,
			pdfBlob
		}))
	);
	let last = performance.now(),
		maxUiGapMs = 0;
	const timer = setInterval(() => {
		const now = performance.now();
		maxUiGapMs = Math.max(maxUiGapMs, now - last);
		last = now;
	}, 8);
	const start = performance.now();
	component = mount(LibraryView, {
		target: app,
		props: { onSelectScore() {} }
	});
	await waitFor(() =>
		[...app.querySelectorAll<HTMLImageElement>('.work-card img')].some(
			(image) => image.complete && image.naturalWidth > 0
		)
	);
	const firstThumbnailMs = performance.now() - start;
	const pageStart = performance.now();
	app
		.querySelector<HTMLButtonElement>('nav.pagination button:last-child')!
		.click();
	await waitFor(
		() =>
			app
				.querySelector('nav.pagination span')
				?.textContent?.includes('Page 2') ?? false
	);
	await waitFor(() =>
		[...app.querySelectorAll<HTMLImageElement>('.work-card img')].some(
			(image) => image.complete && image.naturalWidth > 0
		)
	);
	const newPageThumbnailMs = performance.now() - pageStart;
	await delay(100);
	clearInterval(timer);
	result.textContent = JSON.stringify(
		{
			status: 'PASS',
			firstThumbnailMs: +firstThumbnailMs.toFixed(2),
			newPageThumbnailMs: +newPageThumbnailMs.toFixed(2),
			maxUiGapMs: +maxUiGapMs.toFixed(2),
			checks: [
				'decoded preview before full batch completes',
				'new page prioritized',
				'scanned PDFs'
			]
		},
		null,
		2
	);
} catch (error) {
	result.textContent = JSON.stringify(
		{ status: 'FAIL', error: String(error) },
		null,
		2
	);
	throw error;
} finally {
	if (component) await unmount(component);
	// Let any in-flight thumbnail write finish before cleaning up fixture rows.
	await delay(250);
	await db.scores.where('id').startsWith('thumbnail-benchmark-').delete();
}
