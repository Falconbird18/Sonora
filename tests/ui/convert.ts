import { mount } from 'svelte';
import { mockIPC } from '@tauri-apps/api/mocks';
import App from '../../src/App.svelte';
import { db } from '../../src/lib/db';
import { defaultOmrOptions, type OmrJob } from '../../src/lib/omr';
import { makePdfFixture } from './pdfFixture';
import xml from '../fixtures/engraving.musicxml?raw';
import '../../src/app.css';
if (!import.meta.env.DEV) throw Error('Development-only fixture');
const result = document.querySelector('#result')!;
const target = document.querySelector('#app')!;
function assert(value: unknown, message: string) {
	if (!value) throw Error(message);
}
async function until(check: () => unknown, label: string) {
	for (let i = 0; i < 160; i++) {
		if (check()) return;
		await new Promise((r) => setTimeout(r, 100));
	}
	throw Error(`Timed out: ${label}`);
}
function button(label: string) {
	const found = [...target.querySelectorAll<HTMLButtonElement>('button')]
		.filter(
			(b) =>
				b.textContent?.trim() === label ||
				b.getAttribute('aria-label') === label ||
				b.querySelector('span')?.textContent?.trim() === label
		)
		.at(-1);
	assert(found, `Missing button ${label}`);
	return found!;
}
const sourceId = 'convert-test-source';
const convertedId = 'omr:1-2:0';
if (
	(await db.scores.toArray()).some(
		(s) => ![sourceId, convertedId].includes(s.id)
	)
)
	throw Error('Use an empty isolated test origin.');
await db.scores.delete(convertedId);
const pdfBytes = new Uint8Array(await makePdfFixture('vector', 1));
await db.scores.put({
	id: sourceId,
	title: 'Vocal source',
	composer: 'Sonora test fixture',
	totalPages: 1,
	addedAt: Date.now(),
	thumbnailVersion: 2,
	thumbnailUrl: '/tests/ui/score-preview.png',
	pdfBlob: new Blob([pdfBytes], {
		type: 'application/pdf'
	})
});
let current: OmrJob | null = null;
let cached = false;
let starts = 0;
mockIPC((command, payload) => {
	switch (command) {
		case 'list_omr':
			return current ? [current] : [];
		case 'latest_omr':
			return current?.score_id === payload?.scoreId ? current : null;
		case 'pick_omr_input':
			return '/fixtures/input.pdf';
		case 'read_score_file_binary':
			return pdfBytes.buffer;
		case 'cache_omr_pdf':
			cached = true;
			return '/fixtures/input.pdf';
		case 'start_automatic_omr':
			assert(
				!payload || !('options' in payload),
				'Recognition options must be chosen by Sonora'
			);
			assert(
				payload?.inputPath === '/fixtures/input.pdf',
				'Use the selected library PDF without prompting for it again'
			);
			current = {
				id: `${++starts}-2`,
				score_id: String(payload?.scoreId),
				source: '/fixtures/input.pdf',
				engine: 'Audiveris',
				status: 'running',
				options: defaultOmrOptions(),
				created_at: Date.now(),
				artifacts: [],
				warnings: [],
				error: null,
				log_tail: 'Recognizing'
			};
			return current;
		case 'omr_status':
			current = {
				...current!,
				status: 'complete',
				artifacts: [
					{
						name: 'output/voice.musicxml',
						kind: 'musicxml',
						review: {
							parts: 1,
							measures: 2,
							notes: 6,
							rests: 0,
							lyrics: 6,
							articulations: 1,
							dynamics: 1,
							slurs: 1,
							ties: 0,
							warnings: []
						}
					}
				]
			};
			return current;
		case 'read_omr_artifact':
			return xml;
		case 'install_omr_languages':
			return '/fixtures/tessdata';
		default:
			return null;
	}
});
mount(App, { target });
try {
	await until(() => target.querySelector('.sidebar'), 'library navigation');
	button('Convert').click();
	await until(
		() => target.textContent?.includes('Convert your score'),
		'Convert workspace'
	);
	const select = target.querySelector<HTMLSelectElement>(
		'.source-card select'
	)!;
	select.value = sourceId;
	select.dispatchEvent(new Event('change', { bubbles: true }));
	await until(
		() =>
			[
				...target.querySelectorAll<HTMLButtonElement>(
					'.recognition-card button'
				)
			].some((b) => b.textContent === 'Convert' && !b.disabled),
		'recognition settings'
	);
	button('Convert').click();
	await until(
		() => target.textContent?.includes('View score'),
		'finished MusicXML'
	);
	assert(cached, 'Blob-backed library PDFs must be supported');
	button('Add to library').click();
	await until(
		() => target.textContent?.includes('MusicXML added to your library'),
		'keep result'
	);
	const kept = await db.scores.get(convertedId);
	assert(
		kept?.format === 'musicxml' && kept.totalPages === 2,
		'Keep format and page count'
	);
	assert((await kept!.pdfBlob!.text()) === xml, 'Keep original MusicXML bytes');
	button('View score').click();
	await until(
		() => target.querySelector('.viewer-layer canvas'),
		'finished score in shared viewer'
	);
	await until(
		() => !target.textContent?.includes('Opening score…'),
		'engraved page'
	);
	button('Back to library').click();
	await until(
		() =>
			target.textContent?.includes('Convert your score') &&
			!target.querySelector('.viewer-layer'),
		'return to Convert'
	);
	button('All Scores').click();
	await until(
		() => !!target.querySelector(`[aria-label="Open ${kept!.title}"]`),
		'MusicXML in library'
	);
	target
		.querySelector<HTMLButtonElement>(`[aria-label="Open ${kept!.title}"]`)!
		.click();
	await until(
		() => !!target.querySelector('.viewer-layer canvas'),
		'reopen stored MusicXML'
	);
	button('Back to library').click();
	await until(
		() => !target.querySelector('.viewer-layer'),
		'return to library'
	);
	button('Convert').click();
	await until(
		() => !!target.querySelector('.history-row'),
		'saved conversion history'
	);
	target.querySelector<HTMLButtonElement>('.history-row')!.click();
	await until(
		() => target.textContent?.includes('View score'),
		'resume saved job'
	);
	button('Convert another score').click();
	await until(
		() => starts === 2 && target.textContent?.includes('View score'),
		'file selection starts conversion automatically'
	);
	assert(
		!target.querySelector('.recognition-card input, .recognition-card select'),
		'No recognition options are exposed'
	);
	result.textContent =
		'PASS: Convert sidebar, library source, recognition, view MusicXML, keep/reopen, history and navigation';
} catch (error) {
	result.textContent = `FAIL: ${error}`;
	throw error;
}
