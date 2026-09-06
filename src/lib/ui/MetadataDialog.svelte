<script lang="ts">
	import { Check, Tag, X } from '@lucide/svelte';

	type Props = {
		title: string;
		tags?: string[];
		suggestions?: string[];
		onSave: (tags: string[]) => void;
		onClose: () => void;
	};

	let {
		title,
		tags = [],
		suggestions = [],
		onSave,
		onClose
	}: Props = $props();

	let editingTags = $derived<string[]>([...tags]);
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
</script>

<div
	class="dialog-backdrop"
	role="presentation"
	onclick={(event) => {
		if (event.currentTarget === event.target) onClose();
	}}
>
	<div class="tag-dialog" role="dialog" aria-modal="true" aria-labelledby="tag-dialog-title">
		<header>
			<div>
				<h2 id="tag-dialog-title">Edit tags</h2>
				<p>{title}</p>
			</div>
			<button type="button" class="close-button" onclick={onClose} aria-label="Close">
				<X size={18} strokeWidth={2} />
			</button>
		</header>

		<div class="tag-editor">
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
					{#each filteredSuggestions as tag}
						<button type="button" onclick={() => addTag(tag)}>{tag}</button>
					{/each}
				</div>
			{/if}

			<div class="tag-help">
				<Tag size={14} strokeWidth={2} />
				<span>Press Enter or type a comma to add a tag.</span>
				{#if editingTags.length}
					<button type="button" onclick={() => (editingTags = [])}>Clear all</button>
				{/if}
			</div>
		</div>

		<footer>
			<button type="button" class="secondary" onclick={onClose}>Cancel</button>
			<button type="button" class="primary" onclick={() => onSave(editingTags)}>
				<Check size={16} strokeWidth={2.25} />Save changes
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
		background: rgba(8, 8, 7, 0.72);
		backdrop-filter: blur(8px);
	}
	.tag-dialog {
		width: min(440px, 100%);
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-xl);
		background: #171714;
		box-shadow: var(--sonora-shadow-lg);
		overflow: hidden;
	}
	header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 18px 18px 14px;
		border-bottom: 1px solid #2d2d28;
	}
	header h2 {
		margin: 0;
		font-size: 16px;
		font-weight: 650;
		letter-spacing: -0.02em;
		color: var(--sonora-text);
	}
	header p {
		margin: 4px 0 0;
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-sm);
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		max-width: 320px;
	}
	.close-button {
		width: 34px;
		height: 34px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
		transition:
			background var(--sonora-duration) ease,
			color var(--sonora-duration) ease;
	}
	.close-button:hover {
		background: rgba(255, 255, 255, 0.08);
		color: var(--sonora-text);
	}
	.tag-editor {
		padding: 16px 18px 8px;
	}
	label {
		display: block;
		margin-bottom: 8px;
		color: var(--sonora-text-faint);
		font-size: 11px;
		font-weight: 600;
		letter-spacing: 0.04em;
		text-transform: uppercase;
	}
	.tag-input-wrap {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		min-height: 46px;
		padding: 8px 10px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: #1b1b18;
		transition: border-color var(--sonora-duration) ease;
	}
	.tag-input-wrap:focus-within {
		border-color: color-mix(in srgb, var(--sonora-accent) 50%, #45453d);
	}
	.edit-tag {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		padding: 4px 6px 4px 9px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.07);
		border: 1px solid var(--sonora-border);
		color: var(--sonora-text-secondary);
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
		color: var(--sonora-text-muted);
		cursor: pointer;
	}
	.edit-tag button:hover {
		background: rgba(255, 255, 255, 0.1);
		color: var(--sonora-text);
	}
	input {
		min-width: 120px;
		flex: 1;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--sonora-text);
		font-size: 13px;
		padding: 4px 2px;
	}
	input::placeholder {
		color: #5f5f58;
	}
	.suggestions {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: 6px;
		margin-top: 12px;
	}
	.suggestions > span {
		color: var(--sonora-text-faint);
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
		transition:
			background var(--sonora-duration) ease,
			border-color var(--sonora-duration) ease;
	}
	.suggestions button:hover {
		background: #2a2a25;
		border-color: #45453d;
	}
	.tag-help {
		display: flex;
		align-items: center;
		gap: 6px;
		margin-top: 14px;
		color: #5f5f58;
		font-size: 11px;
	}
	.tag-help button {
		margin-left: auto;
		border: 0;
		background: transparent;
		color: #77776f;
		font-size: 11px;
		cursor: pointer;
	}
	.tag-help button:hover {
		color: #d5d5cd;
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
		transition:
			background var(--sonora-duration) ease,
			border-color var(--sonora-duration) ease;
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
</style>
