<script lang="ts">
	import { Folder, ChevronRight } from '@lucide/svelte';
	import type { LibraryFolder } from '../types';
	let {
		folder,
		list = false,
		scoreCount = 0,
		folderCount = 0,
		onOpen,
		draggable = false
	}: {
		folder: LibraryFolder;
		list?: boolean;
		scoreCount?: number;
		folderCount?: number;
		onOpen: () => void;
		draggable?: boolean;
	} = $props();
	const description = $derived(
		[
			folderCount
				? `${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}`
				: '',
			scoreCount ? `${scoreCount} ${scoreCount === 1 ? 'score' : 'scores'}` : ''
		]
			.filter(Boolean)
			.join(' · ') || 'Empty folder'
	);
</script>

<button
	class="folder"
	{draggable}
	class:list
	onclick={onOpen}
	aria-label={`Open folder ${folder.name}`}>
	<span class="folder-art" aria-hidden="true"
		><Folder
			size={list ? 29 : 62}
			strokeWidth={1.25}
			fill="currentColor" /></span>
	<span class="folder-info"
		><strong title={folder.name}>{folder.name}</strong><span>{description}</span
		></span>
	{#if list}<ChevronRight class="chevron" size={17} strokeWidth={1.5} />{/if}
</button>

<style>
	.folder {
		user-select: none;
		width: 100%;
		min-width: 0;
		display: flex;
		flex-direction: column;
		align-items: stretch;
		gap: 17px;
		padding: 24px 20px 20px;
		border: 1px solid var(--sonora-border);
		border-radius: var(--sonora-radius-lg);
		background: var(--sonora-bg-elevated);
		color: var(--sonora-text);
		text-align: left;
		cursor: pointer;
		transition:
			background 120ms,
			border-color 120ms;
	}
	.folder:hover {
		background: var(--sonora-bg-hover);
		border-color: var(--sonora-border-strong);
	}
	.folder-art {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 96px;
		color: var(--sonora-accent);
	}
	.folder-art :global(svg) {
		fill: var(--sonora-accent-soft);
	}
	.folder-info {
		display: flex;
		flex-direction: column;
		gap: 6px;
		min-width: 0;
	}
	.folder-info strong {
		font-size: 15px;
		font-weight: 550;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.folder-info > span {
		color: var(--sonora-text-muted);
		font-size: 12px;
	}
	.folder.list {
		flex-direction: row;
		align-items: center;
		gap: 14px;
		min-height: 90px;
		padding: 12px;
		border-color: transparent;
		background: transparent;
	}
	.folder.list:hover {
		background: var(--sonora-bg-hover);
	}
	.list .folder-art {
		height: 64px;
		width: 48px;
		flex-shrink: 0;
	}
	.list .folder-info {
		flex: 1;
	}
	:global(.chevron) {
		color: var(--sonora-text-muted);
		margin-right: 8px;
	}
</style>
