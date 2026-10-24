import './review';
import { db } from '../../src/lib/db';
import { tick } from 'svelte';
const result = document.querySelector('#result')!;
const app = document.querySelector('#app')!;
function assert(value: unknown, message: string) {
	if (!value) throw Error(message);
}
async function waitFor(check: () => unknown, label: string) {
	const start = performance.now();
	while (!check()) {
		if (performance.now() - start > 8000) throw Error(`Timed out: ${label}`);
		await new Promise((r) => setTimeout(r, 15));
	}
	await tick();
}
function button(label: string) {
	const value = [...app.querySelectorAll<HTMLButtonElement>('button')].find(
		(b) =>
			b.getAttribute('aria-label') === label || b.textContent?.trim() === label
	);
	if (!value) throw Error(`Missing button: ${label}`);
	return value;
}
function folder(name: string) {
	return app.querySelector<HTMLElement>(`.entry[aria-label="folder ${name}"]`)!;
}
async function drag(source: HTMLElement, target: HTMLElement) {
	const dataTransfer = new DataTransfer();
	source.dispatchEvent(
		new DragEvent('dragstart', {
			bubbles: true,
			cancelable: true,
			dataTransfer
		})
	);
	await tick();
	const over = new DragEvent('dragover', {
		bubbles: true,
		cancelable: true,
		dataTransfer
	});
	target.dispatchEvent(over);
	assert(over.defaultPrevented, 'Valid drag target did not accept drop');
	target.dispatchEvent(
		new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer })
	);
	await tick();
}
try {
	await waitFor(() => folder('Debussy'), 'initial folders');
	const sidebar = app.querySelector('.sidebar nav')!;
	const tabs = [...sidebar.querySelectorAll<HTMLButtonElement>('button')];
	assert(
		tabs[0].textContent?.includes('All Scores') &&
			tabs[1].textContent?.includes('Folders'),
		'Sidebar ordering'
	);
	tabs[0].click();
	await tick();
	assert(!app.querySelector('.folder'), 'Flat library must hide all folders');
	assert(
		app.querySelectorAll('.score-open,.list-open').length === 6,
		'Flat library must include every score'
	);
	const container = app.querySelector<HTMLElement>('.score-grid,.score-list')!;
	const top = container.getBoundingClientRect().top;
	app.querySelector<HTMLButtonElement>('.selection')!.click();
	await tick();
	assert(app.querySelector('.selection-toolbar'), 'Selection bar missing');
	assert(
		container.getBoundingClientRect().top === top,
		'Selection bar shifted library content'
	);
	assert(
		![...app.querySelectorAll('.selection-toolbar button')].some(
			(b) => b.textContent?.trim() === 'Move'
		),
		'Move button still exists'
	);
	button('Clear selection').click();
	tabs[1].click();
	await tick();
	button('Grid view').click();
	await tick();
	assert(
		app.querySelector('.score-grid .folder'),
		'Grid folders must render inside grid'
	);
	await waitFor(() => !button('New folder').disabled, 'folder toolbar ready');
	button('New folder').click();
	await waitFor(
		() => app.querySelector('input[aria-label="Folder name"]'),
		'create folder dialog'
	);
	const input = app.querySelector<HTMLInputElement>(
		'input[aria-label="Folder name"]'
	)!;
	input.value = 'New rehearsal';
	input.dispatchEvent(new Event('input', { bubbles: true }));
	await tick();
	button('Create folder').click();
	await waitFor(() => folder('New rehearsal'), 'new empty disk folder');
	await drag(folder('Debussy'), folder('Rehearsal'));
	await waitFor(() => !folder('Debussy'), 'grid drag move');
	button('Open folder Rehearsal').click();
	await tick();
	button('List view').click();
	await tick();
	assert(
		app.querySelector('.score-list .folder.list'),
		'List folders must render as rows'
	);
	assert(folder('Debussy'), 'Moved folder missing at destination');
	await drag(
		folder('Debussy'),
		app.querySelector<HTMLElement>('.breadcrumbs button[data-folder-drop=""]')!
	);
	await waitFor(() => !folder('Debussy'), 'list drag to home breadcrumb');
	tabs[1].click();
	await tick();
	assert(folder('Debussy'), 'Root drop did not restore folder');
	button('Open folder Debussy').click();
	await tick();
	assert(
		app.querySelectorAll('.list-open').length === 1,
		'Moved folder lost its score'
	);
	tabs[1].click();
	await tick();
	folder('Debussy').querySelector<HTMLButtonElement>('.selection')!.click();
	await tick();
	button('Select all').click();
	await tick();
	assert(
		app.querySelectorAll('.entry.selected').length ===
			app.querySelectorAll('.entry').length,
		'Select all must select the entire current view'
	);
	button('Clear selection').click();
	folder('Debussy').querySelector<HTMLButtonElement>('.selection')!.click();
	await tick();
	const deleting = (await db.scores.toArray()).find(
		(score) => score.sourcePath === 'Debussy/Suite bergamasque.pdf'
	)!;
	await db.annotations.put({
		id: `${deleting.id}:1`,
		scoreId: deleting.id,
		pageNum: 1,
		strokes: [],
		stamps: [],
		notes: []
	});
	await db.lists.put({
		id: 'review-delete-proof',
		name: 'Deletion proof',
		description: '',
		entries: [{ id: 'proof', scoreId: deleting.id }],
		createdAt: 1,
		updatedAt: 1
	});
	button('Delete folder').click();
	await tick();
	assert(
		app.querySelector('[role="dialog"]')?.textContent?.includes('permanently'),
		'Deletion needs explicit permanent-deletion confirmation'
	);
	button('Cancel').click();
	await tick();
	assert(folder('Debussy'), 'Cancelling deletion removed folder');
	button('Delete folder').click();
	await tick();
	button('Delete permanently').click();
	await waitFor(() => !folder('Debussy'), 'folder deletion');
	assert(!(await db.scores.get(deleting.id)), 'Deleted folder retained score');
	assert(
		!(await db.annotations.get(`${deleting.id}:1`)),
		'Deleted folder retained annotations'
	);
	assert(
		(await db.lists.get('review-delete-proof'))?.entries.length === 0,
		'Deleted folder retained dangling program entries'
	);
	assert(folder('Bach'), 'Deletion affected sibling folder');

	result.textContent =
		'PASS: sidebar tabs, flat library, folder grid/list parity, no selection layout shift, toolbar folder creation, grid drag into folder, home breadcrumb drop, preserved scores, select all, deletion confirmation/cancel, deletion cleanup.';
} catch (error) {
	result.textContent = `FAIL: ${error instanceof Error ? error.stack : error}`;
}
