import { mount, tick } from 'svelte';
import SettingsPanel from '../../src/lib/ui/SettingsPanel.svelte';
import { settings } from '../../src/lib/settingsStore';
import { get } from 'svelte/store';
import '../../src/app.css';
if (!import.meta.env.DEV) throw Error('Development-only fixture');
const target = document.querySelector<HTMLElement>('#app')!;
const output = document.querySelector('#result')!;
mount(SettingsPanel, { target, props: { open: true, onClose() {} } });
const assert = (v: unknown, m: string) => {
	if (!v) throw Error(m);
};
try {
	await tick();
	assert(
		!!target.querySelector('nav[aria-label="Settings pages"]'),
		'Sidebar visible'
	);
	assert(
		!target.textContent!.includes('Keep screen on'),
		'Only active page renders'
	);
	const buttons = [...target.querySelectorAll<HTMLButtonElement>('nav button')];
	buttons.find((b) => b.textContent === 'Handwriting')!.click();
	await tick();
	const slider = target.querySelector<HTMLInputElement>(
		'input[aria-label="Pause before conversion"]'
	)!;
	assert(!!slider, 'Handwriting page contains pause setting');
	const original = get(settings).handwritingPauseMs;
	slider.value = '2750';
	slider.dispatchEvent(new Event('input', { bubbles: true }));
	await tick();
	assert(get(settings).handwritingPauseMs === 2750, 'Pause updates settings');
	assert(
		JSON.parse(localStorage.getItem('sonora-app-settings')!)
			.handwritingPauseMs === 2750,
		'Pause persists'
	);
	settings.patch({ handwritingPauseMs: original });
	buttons.find((b) => b.textContent === 'Score viewer')!.click();
	await tick();
	assert(
		target.textContent!.includes('Keep screen on') &&
			!target.querySelector('input[aria-label="Pause before conversion"]'),
		'Switch page without accumulating sections'
	);
	buttons.find((b) => b.textContent === 'Handwriting')!.click();
	await tick();
	output.textContent =
		'PASS: sidebar navigation, exclusive settings pages, pause update and persistence';
} catch (e) {
	output.textContent = `FAIL: ${e}`;
}
