<script lang="ts">
	import { FolderOpen, Music2 } from '@lucide/svelte';
	import { settings } from '../settingsStore';
	import { formatComposer } from '../composerDisplay';
	import type { LibraryWork } from '../works';
	let {
		work,
		previewUrl,
		list = false,
		onOpen
	}: {
		work: LibraryWork;
		previewUrl?: string;
		list?: boolean;
		onOpen: () => void;
	} = $props();
	const preview = $derived(
		previewUrl || work.scores.find((score) => score.thumbnailUrl)?.thumbnailUrl
	);
</script>

<button
	class="work-card"
	class:list
	onclick={onOpen}
	aria-label={`Open ${work.title}, ${work.scores.length} editions and parts`}>
	<div class="cover">
		{#if preview}<img src={preview} alt="" decoding="async" />{:else}<Music2
				size={36} />{/if}<span class="seal"><FolderOpen size={16} /></span>
	</div>
	<div class="info">
		<h3>{work.title}</h3>
		<p>{formatComposer(work.composer, $settings.composerDisplay)}</p>
		<span class="count"
			>{work.scores.length}
			{work.scores.length === 1 ? 'edition or part' : 'editions & parts'}</span>
	</div>
</button>

<style>
	.work-card {
		display: flex;
		flex-direction: column;
		gap: var(--sonora-space);
		padding: var(--sonora-space);
		background: var(--sonora-surface-raised);
		color: var(--sonora-text);
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		box-shadow: var(--sonora-inset), var(--sonora-shadow-xs);
		text-align: left;
		cursor: pointer;
		min-width: 0;
		transition:
			transform var(--sonora-duration) var(--sonora-ease),
			box-shadow var(--sonora-duration) var(--sonora-ease);
	}
	.work-card:hover {
		transform: translateY(-2px);
		box-shadow: var(--sonora-shadow-sm);
		border-color: var(--sonora-accent);
	}
	.cover {
		position: relative;
		width: 100%;
		aspect-ratio: 3/4;
		display: grid;
		place-items: center;
		background: var(--sonora-bg-deep);
		border: 1px solid var(--sonora-border);
		color: var(--sonora-text-muted);
		overflow: hidden;
	}
	img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		background: #fff;
	}
	.seal {
		position: absolute;
		bottom: 8px;
		right: 8px;
		display: grid;
		place-items: center;
		background: var(--sonora-surface-raised);
		color: var(--sonora-accent);
		border: 1px solid var(--sonora-border-strong);
		border-radius: 50%;
		width: 30px;
		height: 30px;
	}
	h3 {
		margin: 0;
		font-size: var(--sonora-text-lg);
		line-height: 1.35;
	}
	p {
		margin: 5px 0;
		color: var(--sonora-text-secondary);
		font-size: var(--sonora-text-sm);
	}
	.count {
		font-size: var(--sonora-text-sm);
		color: var(--sonora-accent);
	}
	.list {
		flex-direction: row;
		align-items: center;
		width: 100%;
	}
	.list .cover {
		width: 54px;
		height: 72px;
		flex: none;
	}
	.list .seal {
		display: none;
	}
</style>
