<script lang="ts">
	import { dialogFocus } from './dialogFocus';
	import { Check, Pencil, Search, X } from '@lucide/svelte';
	import type { ScoreMetadataUpdate } from '../types';
	import {
		findComposer,
		searchComposers,
		type ComposerRecord
	} from '../composerDatabase';

	type Props = {
		title: string;
		workTitle?: string;
		edition?: string;
		publisher?: string;
		editor?: string;
		arranger?: string;
		catalogue?: string;
		key?: string;
		compositionDate?: string;
		movements?: string;

		composer?: string;
		composerId?: string | null;
		composerPeriod?: string;
		composerCountry?: string;
		composerBirthPlace?: string;
		composerBirthYear?: number;
		composerDeathYear?: number;
		year?: number | null;
		ensemble?: string;
		instruments?: string;
		tags?: string[];
		suggestions?: string[];
		onSave: (payload: ScoreMetadataUpdate) => void;
		onClose: () => void;
	};
	let {
		title,
		workTitle = '',
		edition = '',
		publisher = '',
		editor = '',
		arranger = '',
		catalogue = '',
		key = '',
		compositionDate = '',
		movements = '',

		composer = '',
		composerId = null,
		composerPeriod = '',
		composerCountry = '',
		composerBirthPlace = '',
		composerBirthYear,
		composerDeathYear,
		year = null,
		ensemble = '',
		instruments = '',
		tags = [],
		suggestions = [],
		onSave,
		onClose
	}: Props = $props();

	let extra = $state<Record<string, string>>({});
	const extraLabels: Record<string, string> = {
		workTitle: 'Work / folder title',
		edition: 'Edition or part',
		publisher: 'Publisher',
		editor: 'Editor',
		arranger: 'Arranger',
		catalogue: 'Catalogue number',
		key: 'Key',
		compositionDate: 'Date composed',
		movements: 'Movements'
	};
	let editTitle = $state(''),
		editComposer = $state(''),
		editYear = $state(''),
		editEnsemble = $state(''),
		editInstruments = $state('');
	let editingTags = $state<string[]>([]),
		tagDraft = $state('');
	let selectedComposer = $state<ComposerRecord | null>(null),
		composerPickerOpen = $state(false),
		composerSearch = $state('');

	$effect(() => {
		extra = {
			workTitle,
			edition,
			publisher,
			editor,
			arranger,
			catalogue,
			key,
			compositionDate,
			movements
		};
		editTitle = title;
		editComposer = composer;
		editYear = year != null ? String(year) : '';
		editEnsemble = ensemble;
		editInstruments = instruments;
		editingTags = [...tags];
		tagDraft = '';
		selectedComposer = composerId
			? findComposer(composerId)
			: findComposer(composer);
		composerSearch = composer || '';
	});
	const composerSuggestions = $derived(searchComposers(composerSearch, 8));
	const filteredSuggestions = $derived(
		suggestions
			.filter(
				(tag) =>
					!editingTags.some((x) => x.toLowerCase() === tag.toLowerCase()) &&
					(!tagDraft.trim() ||
						tag.toLowerCase().includes(tagDraft.trim().toLowerCase()))
			)
			.slice(0, 8)
	);
	const composerInfo = $derived(selectedComposer ?? null);

	function openComposerPicker() {
		composerSearch = editComposer || selectedComposer?.name || '';
		composerPickerOpen = true;
	}
	function closeComposerPicker() {
		composerPickerOpen = false;
	}
	function chooseComposer(value: ComposerRecord) {
		selectedComposer = value;
		editComposer = value.name;
		composerSearch = value.name;
		composerPickerOpen = false;
	}
	function useCustomComposer() {
		const value = composerSearch.trim();
		if (!value) return;
		selectedComposer = findComposer(value);
		editComposer = value;
		composerPickerOpen = false;
	}
	function handleComposerPickerKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			closeComposerPicker();
		} else if (event.key === 'Enter') {
			event.preventDefault();
			if (composerSuggestions[0]) chooseComposer(composerSuggestions[0]);
			else useCustomComposer();
		}
	}
	function addTag(value = tagDraft) {
		const tag = value.trim().replace(/,+$/, '').trim();
		if (!tag) return;
		if (!editingTags.some((x) => x.toLowerCase() === tag.toLowerCase()))
			editingTags = [...editingTags, tag];
		tagDraft = '';
	}
	function handleTagInput(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ',') {
			event.preventDefault();
			addTag();
		} else if (event.key === 'Backspace' && !tagDraft && editingTags.length)
			editingTags = editingTags.slice(0, -1);
	}
	function submit() {
		const yearNum = editYear.trim()
			? Number.parseInt(editYear.trim(), 10)
			: null;
		onSave({
			...extra,
			title: editTitle.trim() || title,
			composer: editComposer.trim() || composer || 'Unknown Composer',
			composerId: selectedComposer?.id ?? null,
			composerPeriod: selectedComposer?.period,
			composerCountry: selectedComposer?.country,
			composerBirthPlace: selectedComposer?.birthPlace,
			composerBirthYear: selectedComposer?.birthYear,
			composerDeathYear: selectedComposer?.deathYear,
			year: yearNum != null && !Number.isNaN(yearNum) ? yearNum : null,
			ensemble: editEnsemble.trim() || undefined,
			instruments: editInstruments.trim() || undefined,
			tags: [...editingTags]
		});
	}
</script>

<div
	class="dialog-backdrop"
	role="presentation"
	onclick={(event) => {
		if (event.currentTarget === event.target) onClose();
	}}>
	<div
		class="meta-dialog"
		use:dialogFocus
		role="dialog"
		tabindex="-1"
		onkeydown={(event) => {
			if (event.key === 'Escape') {
				event.stopPropagation();
				if (composerPickerOpen) closeComposerPicker();
				else onClose();
			}
		}}
		aria-modal="true"
		aria-labelledby="meta-dialog-title">
		<header>
			<div>
				<h2 id="meta-dialog-title">Edit metadata</h2>
				<p class="subtitle">{title}</p>
			</div>
			<button
				type="button"
				class="close-button"
				onclick={onClose}
				aria-label="Close"><X size={18} /></button>
		</header>
		<div class="body">
			<div class="field-row">
				<label for="meta-title">Title</label><input
					id="meta-title"
					bind:value={editTitle}
					placeholder="Score title" />
			</div>
			<div class="field-row">
				<label for="meta-composer">Composer</label>
				<button
					id="meta-composer"
					type="button"
					class="composer-card"
					class:empty={!composerInfo && !editComposer.trim()}
					onclick={openComposerPicker}
					aria-label="Change composer">
					<div class="composer-card-main">
						<strong
							>{(composerInfo?.name ?? editComposer.trim()) ||
								'Unknown Composer'}</strong
						><Pencil size={14} />
					</div>
					{#if composerInfo}
						<span>{composerInfo.period}</span><span>{composerInfo.country}</span
						><span
							>{composerInfo.birthPlace} · {composerInfo.birthYear}–{composerInfo.deathYear}</span>
					{:else}
						<span>Click to choose a composer</span><span
							>{editComposer.trim()
								? 'Custom composer name'
								: 'No composer selected'}</span>
					{/if}
				</button>
				{#if composerPickerOpen}
					<div
						class="composer-picker"
						use:dialogFocus
						role="dialog"
						tabindex="-1"
						onkeydown={(event) => {
							if (event.key === 'Escape') {
								event.stopPropagation();
								if (composerPickerOpen) closeComposerPicker();
								else onClose();
							}
						}}
						aria-label="Choose composer">
						<div class="picker-search">
							<Search size={15} aria-hidden="true" /><input
								bind:value={composerSearch}
								autocomplete="off"
								placeholder="Search composers…"
								onkeydown={handleComposerPickerKeydown} /><button
								type="button"
								class="picker-close"
								onclick={closeComposerPicker}
								aria-label="Close composer picker"><X size={14} /></button>
						</div>
						{#if composerSuggestions.length}
							<div class="composer-suggestions" role="listbox">
								{#each composerSuggestions as suggestion (suggestion.id)}
									<button
										type="button"
										role="option"
										aria-selected={selectedComposer?.id === suggestion.id}
										class:selected={selectedComposer?.id === suggestion.id}
										onclick={() => chooseComposer(suggestion)}
										><span class="composer-name">{suggestion.name}</span><span
											class="composer-meta"
											>{suggestion.period} · {suggestion.birthYear}–{suggestion.deathYear}</span
										></button>
								{/each}
							</div>
						{:else if composerSearch.trim()}
							<button
								type="button"
								class="custom-composer"
								onclick={useCustomComposer}
								>Use “{composerSearch.trim()}”</button>
						{:else}<p class="picker-empty">
								Start typing to search the composer database.
							</p>{/if}
					</div>
				{/if}
			</div>
			<div class="field-grid">
				<div class="field-row">
					<label for="meta-year">Year composed</label><input
						id="meta-year"
						type="number"
						inputmode="numeric"
						bind:value={editYear}
						placeholder="e.g. 1808" />
				</div>
				<div class="field-row">
					<label for="meta-ensemble">Ensemble</label><input
						id="meta-ensemble"
						bind:value={editEnsemble}
						placeholder="String Quartet, Orchestra…" />
				</div>
			</div>
			<div class="field-row">
				<label for="meta-instruments">Instruments</label><input
					id="meta-instruments"
					bind:value={editInstruments}
					placeholder="Violin, Piano, Cello…" />
			</div>
			<div class="field-row">
				<label for="tag-input">Tags</label>
				<div class="tag-input-wrap">
					{#each editingTags as tag}<span class="edit-tag"
							>{tag}<button
								type="button"
								onclick={() =>
									(editingTags = editingTags.filter((x) => x !== tag))}
								aria-label={`Remove ${tag}`}><X size={12} /></button
							></span
						>{/each}<input
						id="tag-input"
						bind:value={tagDraft}
						onkeydown={handleTagInput}
						onblur={() => addTag()}
						placeholder={editingTags.length
							? 'Add another tag…'
							: 'Type a tag and press Enter…'} />
				</div>
				{#if filteredSuggestions.length}<div class="suggestions">
						<span>Suggestions</span
						>{#each filteredSuggestions as suggestion}<button
								type="button"
								onclick={() => addTag(suggestion)}>{suggestion}</button
							>{/each}
					</div>{/if}
			</div>
			<details class="work-metadata">
				<summary>Work & edition</summary>
				<p class="subtitle">
					Use the same work title to group editions and parts together.
				</p>
				{#each Object.entries(extraLabels) as [key, label]}
					<div class="field-row">
						<label for={`meta-${key}`}>{label}</label><input
							id={`meta-${key}`}
							bind:value={extra[key]} />
					</div>
				{/each}
			</details>
		</div>
		<footer>
			<button type="button" class="secondary" onclick={onClose}>Cancel</button
			><button type="button" class="primary" onclick={submit}
				><Check size={14} />Save</button>
		</footer>
	</div>
</div>

<style>
	.dialog-backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		display: grid;
		place-items: center;
		padding: 24px;
		background:var(--sonora-scrim);
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
	}
	.meta-dialog {
		width: min(520px, 100%);
		max-height: min(90vh, 760px);
		display: flex;
		flex-direction: column;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-lg);
		background: var(--sonora-surface-raised);
		box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
		overflow: hidden;
	}
	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 18px;
		border-bottom: 1px solid var(--sonora-border-strong);
	}
	header h2 {
		margin: 0;
		font-size: 16px;
		color: var(--sonora-text);
	}
	.subtitle {
		margin: 4px 0 0;
		font-size: var(--sonora-text-sm);
		color: var(--sonora-text-muted);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 360px;
	}
	.close-button {
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
	}
	.close-button:hover {
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
	}
	.body {
		flex: 1;
		overflow-y: auto;
		padding: 16px 18px 8px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}
	.field-row {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.field-grid {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	label {
		font-size: var(--sonora-text-sm);
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: var(--sonora-text-muted);
	}
	.field-row > input {
		width: 100%;
		box-sizing: border-box;
		padding: 9px 11px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-surface-raised);
		color: var(--sonora-text);
		font-size: var(--sonora-text-md);
		outline: 0;
	}
	.field-row > input:focus {
		border-color: var(--sonora-border-focus);
		box-shadow: 0 0 0 3px var(--sonora-accent-soft);
	}
	.field-row > input::placeholder {
		color: var(--sonora-text-muted);
	}
	.composer-card {
		position: relative;
		width: 100%;
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 4px 12px;
		padding: 12px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-surface-raised);
		color: inherit;
		text-align: left;
		cursor: pointer;
		transition:
			border-color 0.15s ease,
			background 0.15s ease,
			transform 0.15s ease;
	}
	.composer-card:hover {
		border-color: var(--sonora-border-focus);
		background: var(--sonora-surface-raised);
		transform: translateY(-1px);
	}
	.composer-card:focus-visible {
		outline: 0;
		border-color: var(--sonora-border-focus);
		box-shadow: 0 0 0 3px var(--sonora-accent-soft);
	}
	.composer-card.empty {
		border-style: dashed;
	}
	.composer-card-main {
		grid-column: 1/-1;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}
	.composer-card strong {
		color: var(--sonora-text);
		font-size: var(--sonora-text-md);
	}
	.composer-card-main :global(svg) {
		color: var(--sonora-text-muted);
	}
	.composer-card span {
		font-size: var(--sonora-text-sm);
		color: var(--sonora-text-muted);
	}
	.composer-picker {
		position: relative;
		z-index: 10;
		margin-top: 6px;
		padding: 8px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-surface-raised);
		box-shadow: 0 16px 36px rgba(0, 0, 0, 0.4);
	}
	.picker-search {
		display: flex;
		align-items: center;
		gap: 7px;
		padding: 7px 9px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-surface-raised);
		color: var(--sonora-text-muted);
	}
	.picker-search:focus-within {
		border-color: var(--sonora-border-focus);
	}
	.picker-search input {
		min-width: 0;
		flex: 1;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--sonora-text);
		font-size: var(--sonora-text-md);
	}
	.picker-search input::placeholder {
		color: var(--sonora-text-muted);
	}
	.picker-close {
		width: 24px;
		height: 24px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 6px;
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
	}
	.picker-close:hover {
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
	}
	.composer-suggestions {
		margin-top: 6px;
		max-height: 250px;
		overflow: auto;
	}
	.composer-suggestions button {
		display: flex;
		flex-direction: column;
		align-items: flex-start;
		width: 100%;
		padding: 9px 10px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--sonora-text);
		cursor: pointer;
		text-align: left;
	}
	.composer-suggestions button:hover,
	.composer-suggestions button.selected {
		background: var(--sonora-bg-hover);
	}
	.composer-name {
		font-size: var(--sonora-text-md);
		font-weight: 600;
	}
	.composer-meta {
		margin-top: 2px;
		font-size: var(--sonora-text-sm);
		color: var(--sonora-text-muted);
	}
	.custom-composer {
		width: 100%;
		margin-top: 6px;
		padding: 9px 10px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 8px;
		background: var(--sonora-surface-raised);
		color: var(--sonora-text);
		text-align: left;
		font-size: var(--sonora-text-sm);
		cursor: pointer;
	}
	.custom-composer:hover {
		background: var(--sonora-surface-raised);
	}
	.picker-empty {
		margin: 12px 4px 4px;
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-sm);
	}
	.tag-input-wrap {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		min-height: 42px;
		padding: 6px 8px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-surface-raised);
	}
	.tag-input-wrap:focus-within {
		border-color: var(--sonora-border-focus);
	}
	.edit-tag {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 6px 4px 9px;
		border-radius: 999px;
		background: var(--sonora-bg-hover);
		border: 1px solid var(--sonora-border-strong);
		color: var(--sonora-text);
		font-size: var(--sonora-text-sm);
	}
	.edit-tag button {
		width: 18px;
		height: 18px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
	}
	.tag-input-wrap input {
		min-width: 120px;
		flex: 1;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--sonora-text);
		font-size: var(--sonora-text-md);
		padding: 4px 2px;
	}
	.suggestions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 10px;
	}
	.suggestions > span {
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-sm);
		text-transform: uppercase;
	}
	.suggestions button {
		padding: 5px 9px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 999px;
		background: var(--sonora-surface-raised);
		color: var(--sonora-text);
		font-size: var(--sonora-text-sm);
		cursor: pointer;
	}
	.suggestions button:hover {
		background: var(--sonora-surface-raised);
	}
	footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 13px 18px;
		border-top: 1px solid var(--sonora-border-strong);
		background: var(--sonora-surface-raised);
	}
	.secondary,
	.primary {
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
		display: inline-flex;
		align-items: center;
		gap: 7px;
		border-radius: var(--sonora-radius-md);
		padding: 9px 13px;
		font-size: var(--sonora-text-sm);
		font-weight: 600;
		cursor: pointer;
	}
	.secondary {
		border: 1px solid var(--sonora-border-strong);
		background: var(--sonora-surface-raised);
		color: var(--sonora-text-muted);
	}
	.primary {
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
		border: 1px solid var(--sonora-border-strong);
		background: var(--sonora-surface-raised);
		color: var(--sonora-text);
	}
	@media (max-width: 520px) {
		.field-grid {
			grid-template-columns: 1fr;
		}
		.composer-card {
			grid-template-columns: 1fr;
		}
	}
	.primary {
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
		border-color: transparent;
	}
	.work-metadata {
		margin-top: var(--sonora-space);
		border-top: 1px solid var(--sonora-border);
		padding-top: var(--sonora-space);
	}
	.work-metadata summary {
		cursor: pointer;
		color: var(--sonora-accent);
		margin-bottom: var(--sonora-space);
	}
</style>
