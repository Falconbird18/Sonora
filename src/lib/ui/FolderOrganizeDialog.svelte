<script lang="ts">
	import { FolderPlus, Pencil, Trash2, X } from '@lucide/svelte';
	import { untrack } from 'svelte';
	import { dialogFocus } from './dialogFocus';
	let {
		mode,
		folders,
		initialParent = '',
		initialName = '',
		busy = false,
		error = '',
		count = 0,
		deletePaths = [],
		deleteScoreCount = 0,
		onSubmit,
		onClose
	}: {
		mode: 'create' | 'rename' | 'delete';
		deletePaths?: string[];
		deleteScoreCount?: number;
		folders: { id: string; path: string }[];
		initialParent?: string;
		initialName?: string;
		busy?: boolean;
		error?: string;
		count?: number;
		onSubmit: (parent: string, name: string, moveSelected: boolean) => void;
		onClose: () => void;
	} = $props();
	let parent = $state(untrack(() => initialParent));
	let name = $state(untrack(() => initialName));
	let moveSelected = $state(false);
	const title = $derived(
		mode === 'create'
			? 'New folder'
			: mode === 'delete'
				? 'Delete folders?'
				: 'Rename folder'
	);
</script>

<svelte:window
	onkeydown={(event) => {
		if (event.key === 'Escape' && !busy) {
			event.stopPropagation();
			onClose();
		}
	}} />
<div
	class="backdrop"
	role="presentation"
	onclick={(event) => {
		if (event.target === event.currentTarget && !busy) onClose();
	}}>
	<div
		class="dialog"
		role="dialog"
		tabindex="-1"
		aria-modal="true"
		aria-labelledby="organize-title"
		use:dialogFocus>
		<form
			onsubmit={(event) => {
				event.preventDefault();
				onSubmit(parent, name, moveSelected);
			}}>
			<header>
				<span class="dialog-icon"
					>{#if mode === 'create'}<FolderPlus
							size={22} />{:else if mode === 'delete'}<Trash2
							size={22} />{:else}<Pencil size={22} />{/if}</span
				><button
					class="close"
					type="button"
					aria-label="Close folder dialog"
					disabled={busy}
					onclick={onClose}><X size={18} /></button>
			</header>
			<h2 id="organize-title">{title}</h2>
			{#if mode === 'delete'}
				<p>
					This permanently deletes these folders and everything inside from your
					computer, including subfolders, PDFs and metadata. This cannot be
					undone.
				</p>
				<ul class="delete-paths">
					{#each deletePaths as path}<li>{path}</li>{/each}
				</ul>
				<p>
					{deleteScoreCount}
					{deleteScoreCount === 1 ? 'score' : 'scores'} will be removed from Sonora,
					including their annotations and list entries.
				</p>
			{:else}
				<p>Keep your scores organized, just like on your computer.</p>
				<label
					>Folder name<input
						aria-label="Folder name"
						bind:value={name}
						placeholder="e.g. Rehearsal scores"
						disabled={busy} /></label>
				{#if mode === 'create'}<label
						>Create in<select
							aria-label="Destination folder"
							bind:value={parent}
							disabled={busy}
							><option value="">Library</option
							>{#each folders as folder (folder.id)}<option value={folder.id}
									>{folder.path}</option
								>{/each}</select
						></label
					>{/if}
			{/if}
			{#if mode === 'create' && count}<label class="move-option"
					><input type="checkbox" bind:checked={moveSelected} disabled={busy} /> Move
					selected items into this folder</label
				>{/if}
			{#if error}<div class="error" role="alert">{error}</div>{/if}
			<footer>
				<button
					class="secondary"
					type="button"
					onclick={onClose}
					disabled={busy}>Cancel</button
				><button
					class="primary"
					class:danger={mode === 'delete'}
					disabled={busy || (mode !== 'delete' && !name.trim())}
					>{busy
						? 'Saving…'
						: mode === 'delete'
							? 'Delete permanently'
							: mode === 'rename'
								? 'Save name'
								: 'Create folder'}</button>
			</footer>
		</form>
	</div>
</div>

<style>
	.delete-paths {
		max-height: 150px;
		overflow: auto;
		padding-left: 18px;
		font-size: 13px;
		line-height: 1.7;
		overflow-wrap: anywhere;
	}
	.primary.danger {
		background: var(--sonora-danger);
		color: white;
	}
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		padding: 24px;
		background: #0007;
		backdrop-filter: blur(8px);
	}
	.dialog {
		width: min(440px, 100%);
		border: 1px solid var(--sonora-border-strong);
		border-radius: 20px;
		padding: 28px;
		background: var(--sonora-bg-elevated);
		box-shadow: var(--sonora-shadow-lg);
		color: var(--sonora-text);
	}
	header {
		display: flex;
		justify-content: space-between;
		align-items: center;
		margin-bottom: 20px;
	}
	.dialog-icon {
		display: grid;
		place-items: center;
		width: 44px;
		height: 44px;
		border-radius: 12px;
		background: var(--sonora-accent-soft);
		color: var(--sonora-accent);
	}
	.close {
		display: grid;
		place-items: center;
		width: 32px;
		height: 32px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
	}
	h2 {
		font-size: 24px;
		margin: 0 0 8px;
	}
	p {
		font-size: 14px;
		line-height: 1.5;
		color: var(--sonora-text-muted);
		margin: 0 0 24px;
	}
	label {
		display: flex;
		flex-direction: column;
		gap: 8px;
		margin: 16px 0;
		font-size: 13px;
		color: var(--sonora-text-secondary);
	}
	input:not([type='checkbox']),
	select {
		width: 100%;
		box-sizing: border-box;
		padding: 12px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 9px;
		background: var(--sonora-bg-workspace);
		color: var(--sonora-text);
		font: inherit;
	}
	input:focus,
	select:focus {
		outline: 2px solid var(--sonora-accent);
		outline-offset: 1px;
	}
	.move-option {
		flex-direction: row;
		align-items: center;
		gap: 9px;
	}
	input[type='checkbox'] {
		accent-color: var(--sonora-accent);
		width: 16px;
		height: 16px;
	}
	footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		margin-top: 28px;
	}
	footer button {
		padding: 10px 17px;
		border-radius: 9px;
		border: 1px solid var(--sonora-border-strong);
		font: inherit;
		font-size: 13px;
		cursor: pointer;
	}
	.secondary {
		background: transparent;
		color: var(--sonora-text);
	}
	.primary {
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
		border-color: transparent;
	}
	button:disabled {
		opacity: 0.45;
		cursor: default;
	}
	.error {
		color: var(--sonora-danger);
		font-size: 13px;
		line-height: 1.5;
	}
</style>
