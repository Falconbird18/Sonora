<script lang="ts">
	import {
		ArrowUp,
		ArrowDown,
		Plus,
		Trash2,
		Play,
		GripVertical,
		Pencil,
		Check
	} from '@lucide/svelte';
	import { addToList, updateList, reorderEntries } from '../lists';
	import { db } from '../db';
	import type { ScoreList, ScoreItem } from '../types';
	import { settings } from '../settingsStore';
	import { formatComposer } from '../composerDisplay';
	import IconButton from './IconButton.svelte';
	import TextButton from './TextButton.svelte';
	import SearchField from './SearchField.svelte';
	let {
		list,
		scores,
		onChanged,
		onOpen,
		onDeleted
	}: {
		list: ScoreList;
		scores: ScoreItem[];
		onChanged: () => Promise<void>;
		onOpen: (score: ScoreItem, entryId: string) => void;
		onDeleted: () => void;
	} = $props();
	let adding = $state(false),
		editing = $state(false),
		confirmingDelete = $state(false),
		draft = $state(''),
		description = $state(''),
		search = $state(''),
		error = $state(''),
		busy = $state(false);
	let dragId = $state<string | null>(null);
	const byId = $derived(new Map(scores.map((score) => [score.id, score])));
	const candidates = $derived(
		scores.filter((score) =>
			`${score.title} ${score.composer} ${score.edition || ''} ${score.publisher || ''} ${score.editor || ''}`
				.toLowerCase()
				.includes(search.toLowerCase())
		)
	);
	async function run(action: () => Promise<unknown>) {
		busy = true;
		error = '';
		try {
			await action();
			await onChanged();
		} catch (e) {
			error = String(e);
		} finally {
			busy = false;
		}
	}
	async function move(entryId: string, index: number) {
		await run(() =>
			updateList(list.id, (current) => ({
				...current,
				entries: reorderEntries(current.entries, entryId, index)
			}))
		);
	}
	function rename() {
		draft = list.name;
		description = list.description;
		editing = true;
	}
	async function saveName() {
		if (!draft.trim()) return;
		await run(() =>
			updateList(list.id, (current) => ({
				...current,
				name: draft.trim(),
				description: description.trim()
			}))
		);
		editing = false;
	}
</script>

<section class="program" aria-label="Ordered score list">
	<div class="program-actions">
		<div>
			<p class="eyebrow">Concert program</p>
			<p>
				{list.entries.length}
				{list.entries.length === 1 ? 'score' : 'scores'} · Your performance order
			</p>
			{#if list.description}<p>{list.description}</p>{/if}
		</div>
		<div class="buttons">
			<TextButton onclick={rename}><Pencil size={15} /> Edit list</TextButton
			><TextButton primary onclick={() => (adding = !adding)}
				><Plus size={16} /> Add scores</TextButton
			><IconButton
				title="Delete list"
				ariaLabel="Delete list"
				onclick={() => (confirmingDelete = !confirmingDelete)}
				><Trash2 size={16} /></IconButton>
		</div>
	</div>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	{#if confirmingDelete}<div class="edit-box">
			<p>
				Delete “{list.name}”? Your scores and annotations will stay in the
				library.
			</p>
			<div class="buttons">
				<TextButton onclick={() => (confirmingDelete = false)}
					>Keep list</TextButton
				><TextButton
					onclick={() =>
						void run(async () => {
							await db.lists.delete(list.id);
							onDeleted();
						})}>Delete list</TextButton>
			</div>
		</div>{/if}
	{#if editing}<form
			class="edit-box"
			onsubmit={(event) => {
				event.preventDefault();
				void saveName();
			}}>
			<label>List name<input bind:value={draft} required /></label><label
				>Notes<textarea bind:value={description} rows="2"></textarea></label>
			<div class="buttons">
				<TextButton onclick={() => (editing = false)}>Cancel</TextButton><button
					class="save"
					disabled={busy}><Check size={15} /> Save</button>
			</div>
		</form>{/if}
	{#if adding}<div class="picker">
			<h2>Add scores to this program</h2>
			<SearchField
				bind:value={search}
				ariaLabel="Find scores for list"
				placeholder="Search titles, composers, or parts…" />
			<div class="choices">
				{#each candidates as score (score.id)}<button
						disabled={busy}
						onclick={() => void run(() => addToList(list.id, [score.id]))}
						><span
							><strong>{score.title}</strong><small
								>{[
									formatComposer(score.composer, $settings.composerDisplay),
									score.edition,
									score.publisher || score.editor
								]
									.filter(Boolean)
									.join(' · ')}</small
							></span
						><Plus size={18} /></button
					>{/each}{#if !candidates.length}<p>No matching scores.</p>{/if}
			</div>
			<TextButton onclick={() => (adding = false)}>Done adding</TextButton>
		</div>{/if}
	{#if !list.entries.length}<div class="empty">
			<h2>Your program starts here</h2>
			<p>Add editions or parts, then arrange them in performance order.</p>
			<TextButton primary onclick={() => (adding = true)}
				>Choose scores</TextButton>
		</div>{:else}
		<ol class="entries">
			{#each list.entries as entry, index (entry.id)}
				{@const score = byId.get(entry.scoreId)}
				<li
					draggable={!busy}
					ondragstart={(event) => {
						dragId = entry.id;
						event.dataTransfer?.setData('text/plain', entry.id);
					}}
					ondragend={() => (dragId = null)}
					ondragover={(event) => event.preventDefault()}
					ondrop={(event) => {
						event.preventDefault();
						if (dragId) void move(dragId, index);
						dragId = null;
					}}
					class:dragging={dragId === entry.id}>
					<span class="grip" aria-hidden="true"><GripVertical size={16} /></span
					><span class="number">{index + 1}</span>
					<button
						class="entry-open"
						disabled={!score || busy}
						onclick={() => score && onOpen(score, entry.id)}
						><strong>{score?.title || 'Score unavailable'}</strong><span
							>{score
								? [
										formatComposer(score.composer, $settings.composerDisplay),
										score.edition,
										score.publisher || score.editor
									]
										.filter(Boolean)
										.join(' · ')
								: 'This score was removed from the library.'}</span
						></button>
					<div class="entry-actions">
						<IconButton
							title="Open score"
							ariaLabel={`Open item ${index + 1}`}
							disabled={!score || busy}
							onclick={() => score && onOpen(score, entry.id)}
							><Play size={16} /></IconButton
						><IconButton
							title="Move up"
							ariaLabel={`Move item ${index + 1} up`}
							disabled={index === 0 || busy}
							onclick={() => void move(entry.id, index - 1)}
							><ArrowUp size={16} /></IconButton
						><IconButton
							title="Move down"
							ariaLabel={`Move item ${index + 1} down`}
							disabled={index === list.entries.length - 1 || busy}
							onclick={() => void move(entry.id, index + 1)}
							><ArrowDown size={16} /></IconButton
						><IconButton
							title="Remove from list"
							ariaLabel={`Remove item ${index + 1} from list`}
							disabled={busy}
							onclick={() =>
								void run(() =>
									updateList(list.id, (current) => ({
										...current,
										entries: current.entries.filter(
											(item) => item.id !== entry.id
										)
									}))
								)}><Trash2 size={16} /></IconButton>
					</div>
				</li>
			{/each}
		</ol>
	{/if}
</section>

<style>
	.program {
		display: grid;
		gap: var(--sonora-space);
	}
	.program-actions {
		display: flex;
		justify-content: space-between;
		gap: var(--sonora-space);
		flex-wrap: wrap;
	}
	p {
		margin: 4px 0;
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-sm);
		line-height: 1.6;
	}
	.eyebrow {
		text-transform: uppercase;
		letter-spacing: 0.12em;
		color: var(--sonora-accent);
		font-size: var(--sonora-text-xs);
	}
	.buttons,
	.entry-actions {
		display: flex;
		gap: 5px;
		align-items: center;
		flex-wrap: wrap;
	}
	.edit-box,
	.picker {
		padding: var(--sonora-space);
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-lg);
		background: var(--sonora-surface-raised);
		box-shadow: var(--sonora-inset), var(--sonora-shadow-xs);
		display: grid;
		gap: 12px;
	}
	label {
		display: grid;
		gap: 6px;
		font-size: var(--sonora-text-sm);
	}
	input,
	textarea {
		padding: 10px;
		background: var(--sonora-bg);
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-sm);
		color: var(--sonora-text);
		width: 100%;
		box-sizing: border-box;
	}
	.save {
		display: flex;
		gap: 6px;
		align-items: center;
		padding: 10px 16px;
		border: 0;
		border-radius: var(--sonora-radius-sm);
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
		cursor: pointer;
	}
	.entries {
		list-style: none;
		padding: 0;
		margin: 0;
		display: grid;
		gap: 10px;
	}
	li {
		display: flex;
		align-items: center;
		gap: 12px;
		padding: var(--sonora-space);
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-surface-raised);
		box-shadow: var(--sonora-inset), var(--sonora-shadow-xs);
	}
	.dragging {
		opacity: 0.45;
	}
	.grip {
		color: var(--sonora-text-faint);
		cursor: grab;
	}
	.number {
		display: grid;
		place-items: center;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 50%;
		width: 30px;
		height: 30px;
		flex-shrink: 0;
		color: var(--sonora-accent);
		font-variant-numeric: tabular-nums;
	}
	.entry-open {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 5px;
		text-align: left;
		background: transparent;
		border: 0;
		color: var(--sonora-text);
		cursor: pointer;
		padding: 6px;
	}
	.entry-open strong {
		font-family: var(--sonora-font-display);
		font-size: var(--sonora-text-lg);
	}
	.entry-open span {
		font-size: var(--sonora-text-sm);
		color: var(--sonora-text-muted);
	}
	h2 {
		font-size: var(--sonora-text-xl);
		margin: 0;
	}
	.choices {
		max-height: 280px;
		overflow: auto;
		display: grid;
		gap: 5px;
	}
	.choices button {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 15px;
		text-align: left;
		background: var(--sonora-bg);
		border: 1px solid var(--sonora-border);
		border-radius: var(--sonora-radius-sm);
		color: var(--sonora-text);
		padding: 10px;
		cursor: pointer;
	}
	.choices small {
		display: block;
		margin-top: 4px;
		color: var(--sonora-text-muted);
	}
	.empty {
		padding: 48px 12px;
		text-align: center;
	}
	.empty p {
		margin: 12px 0 20px;
	}
	.error {
		color: var(--sonora-danger);
	}
	@media (max-width: 900px) {
		li {
			flex-wrap: wrap;
		}
		.entry-open {
			flex-basis: 65%;
		}
		.entry-actions {
			margin-left: auto;
		}
		.grip {
			display: none;
		}
	}
</style>
