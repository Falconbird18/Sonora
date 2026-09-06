<script lang="ts">
	import { Check, X } from '@lucide/svelte';
	import type { ScoreMetadataUpdate } from '../types';

	type Props = {
		title: string;
		composer?: string;
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
		composer = '',
		year = null,
		ensemble = '',
		instruments = '',
		tags = [],
		suggestions = [],
		onSave,
		onClose
	}: Props = $props();

	let editTitle = $state(title);
	let editComposer = $state(composer);
	let editYear = $state(year != null ? String(year) : '');
	let editEnsemble = $state(ensemble);
	let editInstruments = $state(instruments);
	let editingTags = $state<string[]>([...tags]);
	let tagDraft = $state('');

	const filteredSuggestions = $derived(
		suggestions
			.filter(
				(tag) =>
					!editingTags.some((existing) => existing.toLowerCase() === tag.toLowerCase()) &&
					(!tagDraft.trim() || tag.toLowerCase().includes(tagDraft.trim().toLowerCase()))
			)
			.slice(0, 8)
	);

	function addTag(value = tagDraft) {
		const tag = value.trim().replace(/,+$/, '').trim();
		if (!tag) return;
		if (!editingTags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
			editingTags = [...editingTags, tag];
		}
		tagDraft = '';
	}

	function handleTagInput(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ',') {
			event.preventDefault();
			addTag();
		} else if (event.key === 'Backspace' && !tagDraft && editingTags.length) {
			editingTags = editingTags.slice(0, -1);
		}
	}

	function removeTag(tag: string) {
		editingTags = editingTags.filter((item) => item !== tag);
	}

	function submit() {
		const yearNum = editYear.trim() ? Number.parseInt(editYear.trim(), 10) : null;
		// Spread $state arrays into plain data — IndexedDB cannot clone Svelte proxies
		onSave({
			title: editTitle.trim() || title,
			composer: editComposer.trim() || composer || 'Unknown Composer',
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
	}}
>
	<div class="meta-dialog" role="dialog" aria-modal="true" aria-labelledby="meta-dialog-title">
		<header>
			<div>
				<h2 id="meta-dialog-title">Edit metadata</h2>
				<p class="subtitle">{title}</p>
			</div>
			<button type="button" class="close-button" onclick={onClose} aria-label="Close">
				<X size={18} strokeWidth={2} />
			</button>
		</header>

		<div class="body">
			<div class="field-row">
				<label for="meta-title">Title</label>
				<input id="meta-title" bind:value={editTitle} placeholder="Score title" />
			</div>

			<div class="field-row">
				<label for="meta-composer">Composer</label>
				<input id="meta-composer" bind:value={editComposer} placeholder="Composer name" />
			</div>

			<div class="field-grid">
				<div class="field-row">
					<label for="meta-year">Year composed</label>
					<input
						id="meta-year"
						type="number"
						inputmode="numeric"
						bind:value={editYear}
						placeholder="e.g. 1808"
					/>
				</div>
				<div class="field-row">
					<label for="meta-ensemble">Ensemble</label>
					<input
						id="meta-ensemble"
						bind:value={editEnsemble}
						placeholder="String Quartet, Orchestra…"
					/>
				</div>
			</div>

			<div class="field-row">
				<label for="meta-instruments">Instruments</label>
				<input
					id="meta-instruments"
					bind:value={editInstruments}
					placeholder="Violin, Piano, Cello…"
				/>
			</div>

			<div class="field-row">
				<label for="tag-input">Tags</label>
				<div class="tag-input-wrap" class:has-tags={editingTags.length > 0}>
					{#each editingTags as tag}
						<span class="edit-tag">
							{tag}
							<button type="button" onclick={() => removeTag(tag)} aria-label={`Remove ${tag}`}>
								<X size={12} strokeWidth={2.5} />
							</button>
						</span>
					{/each}
					<input
						id="tag-input"
						bind:value={tagDraft}
						onkeydown={handleTagInput}
						onblur={() => addTag()}
						placeholder={editingTags.length ? 'Add another tag…' : 'Type a tag and press Enter…'}
					/>
				</div>

				{#if filteredSuggestions.length}
					<div class="suggestions">
						<span>Suggestions</span>
						{#each filteredSuggestions as suggestion}
							<button type="button" onclick={() => addTag(suggestion)}>{suggestion}</button>
						{/each}
					</div>
				{/if}
			</div>
		</div>

		<footer>
			<button type="button" class="secondary" onclick={onClose}>Cancel</button>
			<button type="button" class="primary" onclick={submit}>
				<Check size={14} strokeWidth={2.5} />
				Save
			</button>
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
		background: rgba(0, 0, 0, 0.55);
		backdrop-filter: blur(6px);
	}
	.meta-dialog {
		width: min(480px, 100%);
		max-height: min(90vh, 720px);
		display: flex;
		flex-direction: column;
		border-radius: 16px;
		border: 1px solid #2d2d28;
		background: #1c1c18;
		box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
		overflow: hidden;
	}
	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 18px 18px 12px;
		border-bottom: 1px solid #2d2d28;
	}
	header h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 650;
		color: #f0f0e8;
	}
	.subtitle {
		margin: 4px 0 0;
		font-size: 12px;
		color: #8a8a82;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 340px;
	}
	.close-button {
		width: 32px;
		height: 32px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: #8a8a82;
		cursor: pointer;
	}
	.close-button:hover {
		background: rgba(255, 255, 255, 0.06);
		color: #f0f0e8;
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
		font-size: 11px;
		font-weight: 600;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		color: #7a7a72;
	}
	.field-row > input {
		width: 100%;
		box-sizing: border-box;
		padding: 9px 11px;
		border: 1px solid #33332e;
		border-radius: 10px;
		background: #22221e;
		color: #e8e8e0;
		font-size: 13px;
		outline: 0;
	}
	.field-row > input:focus {
		border-color: #55554c;
		box-shadow: 0 0 0 3px rgba(230, 230, 222, 0.08);
	}
	.field-row > input::placeholder {
		color: #5f5f58;
	}
	.tag-input-wrap {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		min-height: 42px;
		padding: 6px 8px;
		border: 1px solid #33332e;
		border-radius: 10px;
		background: #22221e;
	}
	.tag-input-wrap:focus-within {
		border-color: #55554c;
		box-shadow: 0 0 0 3px rgba(230, 230, 222, 0.08);
	}
	.edit-tag {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 6px 4px 9px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.07);
		border: 1px solid #33332e;
		color: #c7c7bf;
		font-size: 12px;
	}
	.edit-tag button {
		width: 18px;
		height: 18px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 999px;
		background: transparent;
		color: #8a8a82;
		cursor: pointer;
	}
	.edit-tag button:hover {
		background: rgba(255, 255, 255, 0.1);
		color: #f0f0e8;
	}
	.tag-input-wrap input {
		min-width: 120px;
		flex: 1;
		border: 0;
		outline: 0;
		background: transparent;
		color: #e8e8e0;
		font-size: 13px;
		padding: 4px 2px;
	}
	.tag-input-wrap input::placeholder {
		color: #5f5f58;
	}
	.suggestions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 10px;
	}
	.suggestions > span {
		color: #5f5f58;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-right: 2px;
	}
	.suggestions button {
		padding: 5px 9px;
		border: 1px solid #33332e;
		border-radius: 999px;
		background: #22221e;
		color: #c7c7bf;
		font-size: 11px;
		cursor: pointer;
	}
	.suggestions button:hover {
		background: #2a2a25;
		border-color: #45453d;
	}
	footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 13px 18px;
		border-top: 1px solid #2d2d28;
		background: #181815;
	}
	.secondary,
	.primary {
		display: inline-flex;
		align-items: center;
		gap: 7px;
		border-radius: 10px;
		padding: 9px 13px;
		font-size: 12px;
		font-weight: 600;
		cursor: pointer;
	}
	.secondary {
		border: 1px solid #33332e;
		background: #22221e;
		color: #9d9d95;
	}
	.secondary:hover {
		background: #2a2a25;
		color: #ddd;
	}
	.primary {
		border: 1px solid #3c3c35;
		background: #e6e6de;
		color: #171713;
	}
	.primary:hover {
		background: #f0f0e8;
	}
	@media (max-width: 520px) {
		.field-grid {
			grid-template-columns: 1fr;
		}
	}
</style>
