import { mount, unmount, tick } from 'svelte';
import LibraryView from '../../src/lib/LibraryView.svelte';
import { db } from '../../src/lib/db';
import type { ScoreItem } from '../../src/lib/types';
import '../../src/app.css';

// Never seed or clear a real library. Run on a dedicated localhost port/profile.
if (
	!import.meta.env.DEV ||
	(await db.scores.toArray()).some(
		(score) => !score.id.startsWith('benchmark-')
	) ||
	(await db.folders.count()) ||
	(await db.lists.count())
) {
	throw Error(
		'Benchmark requires an empty isolated origin with no folders or lists.'
	);
}
const result = document.querySelector('#benchmark-result')!;
const app = document.querySelector<HTMLElement>('#app')!;
const nextFrame = () =>
	new Promise<void>((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
	);
async function waitFor(test: () => boolean) {
	const start = performance.now();
	while (!test()) {
		if (performance.now() - start > 30000)
			throw Error('UI benchmark timed out');
		await new Promise((r) => setTimeout(r, 10));
	}
	await nextFrame();
}
const rows: Record<string, number>[] = [];
const image =
	'data:image/svg+xml,' +
	encodeURIComponent(
		'<svg xmlns="http://www.w3.org/2000/svg" width="120" height="160"><rect width="120" height="160" fill="white"/></svg>'
	);
try {
	for (const size of [1000, 10000, 50000]) {
		await db.scores.clear();
		const scores: ScoreItem[] = Array.from({ length: size }, (_, i) => ({
			id: `benchmark-${i}`,
			title: `Sonata ${String(i).padStart(6, '0')}`,
			composer: 'Johann Sebastian Bach',
			metadataEdited: true,
			addedAt: i + 1,
			totalPages: 20,
			thumbnailUrl: image,
			thumbnailVersion: 2,
			tags: ['Piano']
		}));
		let start = performance.now();
		await db.scores.bulkPut(scores);
		const writeMs = performance.now() - start;
		start = performance.now();
		await db.scores.orderBy('addedAt').reverse().toArray();
		const readMs = performance.now() - start;
		start = performance.now();
		const component = mount(LibraryView, {
			target: app,
			props: { paused: true, onSelectScore() {} }
		});
		await waitFor(() => app.querySelectorAll('.work-card').length === 60);
		const mountMs = performance.now() - start;
		const mountedCards = app.querySelectorAll('.work-card').length;
		const next = [
			...app.querySelectorAll<HTMLButtonElement>('nav.pagination button')
		].find((button) => button.textContent === 'Next')!;
		start = performance.now();
		next.click();
		await waitFor(
			() =>
				app
					.querySelector('nav.pagination span')
					?.textContent?.includes('Page 2') ?? false
		);
		const pageMs = performance.now() - start;
		const input = app.querySelector<HTMLInputElement>(
			'input[aria-label="Search scores"]'
		)!;
		start = performance.now();
		input.value = 'Sonata 000999';
		input.dispatchEvent(new Event('input', { bubbles: true }));
		await tick();
		await waitFor(() => app.querySelectorAll('.work-card').length === 1);
		const searchMs = performance.now() - start;
		app.querySelector<HTMLButtonElement>('button[aria-label="List view"]')!.click();
		await waitFor(() => !!app.querySelector('.work-card.list'));
		app.querySelector<HTMLButtonElement>('.work-card')!.click();
		await waitFor(() => app.querySelectorAll('.list-row').length === 1);
		app.querySelector<HTMLButtonElement>('button[aria-label="Add to favorites"]')!.click();
		await waitFor(() => !!app.querySelector('button[aria-label="Remove from favorites"]'));
		if (!(await db.scores.get('benchmark-999'))?.favorite) throw Error('Favorite update did not persist');
		rows.push({
			size,
			writeMs,
			readMs,
			mountMs,
			pageMs,
			searchMs,
			mountedCards
		});
		await unmount(component);
	}
	result.textContent = JSON.stringify(
		{ status: 'PASS', userAgent: navigator.userAgent, rows },
		null,
		2
	);
} catch (error) {
	result.textContent = JSON.stringify(
		{ status: 'FAIL', error: String(error), rows },
		null,
		2
	);
	throw error;
} finally {
	await db.scores.clear();
}
