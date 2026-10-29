import { mount, unmount } from 'svelte';
import { mockIPC } from '@tauri-apps/api/mocks';
import OmrPanel from '../../src/lib/ui/OmrPanel.svelte';
import { defaultOmrOptions, type OmrJob } from '../../src/lib/omr';
import type { ScoreItem } from '../../src/lib/types';
import '../../src/lib/styles/tokens.css';

if (!import.meta.env.DEV) throw Error('Development-only fixture');
const result = document.querySelector('#result')!;
const target = document.querySelector('#app')!;
const assert = (ok: unknown, message: string) => {
	if (!ok) throw Error(message);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => boolean) {
	for (let i = 0; i < 100; i++) {
		if (check()) return;
		await wait(100);
	}
	throw Error('Timed out waiting for OMR panel');
}
function button(text: string) {
	const found = [...target.querySelectorAll('button')].find((b) =>
		b.textContent?.includes(text)
	);
	assert(found, `Missing button ${text}`);
	return found!;
}
const score: ScoreItem = {
	id: 'omr-fixture',
	title: 'Vocal score',
	composer: 'Schumann',
	nativePath: '/scores/voice.pdf',
	totalPages: 2,
	addedAt: 0
};
let current: OmrJob | null = null;
let saved = false;
let cancelled = false;
mockIPC((command, payload) => {
	switch (command) {
		case 'latest_omr':
			return current;
		case 'omr_status':
			return current;
		case 'start_automatic_omr':
			assert(
				payload?.inputPath === score.nativePath,
				'Must recognize the original document'
			);
			current = {
				id: '1-2',
				score_id: score.id,
				status: 'running',
				source: score.nativePath!,
				engine: 'Audiveris',
				options: defaultOmrOptions(),
				created_at: Date.now(),
				artifacts: [],
				warnings: [],
				error: null,
				log_tail: 'HEADS',
				progress: {
					phase: 'recognizing',
					total_pages: 17,
					current_page: 4,
					completed_pages: 3,
					step: 'TEXTS'
				}
			};
			return current;
		case 'cancel_omr':
			cancelled = true;
			current = { ...current!, status: 'cancelled' };
			return;
		case 'save_omr_artifact':
			saved = true;
			assert(payload?.index === 0, 'Save the selected movement');
			return true;
		default:
			throw Error(`Unexpected command ${command}`);
	}
});
let panel = mount(OmrPanel, { target, props: { score, onClose: () => {} } });
try {
	await until(() =>
		[...target.querySelectorAll('button')].some(
			(b) => b.textContent === 'Convert' && !b.disabled
		)
	);
	button('Convert').click();
	await until(() => target.textContent!.includes('Cancel'));
	assert(
		!target.querySelector('input, select'),
		'Conversion exposes no recognition settings'
	);
	assert(
		target.textContent!.includes('Reading text and expression marks'),
		'Current recognition stage is readable'
	);
	assert(
		target.textContent!.includes('Page 4'),
		'Current source page is visible'
	);
	const progressBar = target.querySelector('progress')!;
	assert(
		progressBar.value === 3 && progressBar.max === 17,
		'Page progress uses real source counts'
	);
	current = {
		...current!,
		progress: { ...current!.progress!, phase: 'exporting' }
	};
	await until(() =>
		target.textContent!.includes('Creating your MusicXML score')
	);
	assert(
		!target.querySelector('progress')!.hasAttribute('value'),
		'Export must not imply a measured percentage'
	);
	await unmount(panel);
	panel = mount(OmrPanel, { target, props: { score, onClose: () => {} } });
	await until(() => target.textContent!.includes('Cancel'));
	assert(
		current?.status === 'running',
		'Closing the panel must preserve the job'
	);
	current = {
		...current!,
		status: 'complete',
		artifacts: [
			{
				name: 'output/voice.xml',
				kind: 'musicxml',
				review: {
					parts: 2,
					measures: 24,
					notes: 176,
					rests: 27,
					lyrics: 30,
					articulations: 1,
					dynamics: 7,
					slurs: 25,
					ties: 21,
					warnings: ['Part P2, measure 10: check rhythm']
				}
			}
		],
		log_tail: 'Export complete'
	};
	await until(() => target.textContent!.includes('Download MusicXML'));
	assert(
		target.textContent!.includes('measure 10'),
		'Measure-level review must be available'
	);
	button('Download MusicXML').click();
	await until(() => saved);
	button('Convert again').click();
	await until(() => target.textContent!.includes('Cancel'));
	button('Cancel').click();
	await until(() => cancelled);
	await until(() => target.textContent!.includes('Conversion cancelled'));
	result.textContent =
		'PASS: original input, background recognition, reconnect, review, export and cancellation';
	// Leave a complete result visible for manual visual review.
	current = {
		...current!,
		status: 'complete',
		artifacts: [
			{
				name: 'output/voice.xml',
				kind: 'musicxml',
				review: {
					parts: 2,
					measures: 24,
					notes: 176,
					rests: 27,
					lyrics: 30,
					articulations: 1,
					dynamics: 7,
					slurs: 25,
					ties: 21,
					warnings: ['Part P2, measure 10: check rhythm']
				}
			}
		]
	};
	if (new URLSearchParams(location.search).has('progress')) {
		current = {
			...current!,
			status: 'running',
			artifacts: [],
			progress: {
				phase: 'recognizing',
				total_pages: 17,
				completed_pages: 3,
				current_page: 4,
				step: 'TEXTS'
			}
		};
	}
	await unmount(panel);
	panel = mount(OmrPanel, { target, props: { score, onClose: () => {} } });
} catch (error) {
	result.textContent = `FAIL: ${error}`;
	throw error;
}
