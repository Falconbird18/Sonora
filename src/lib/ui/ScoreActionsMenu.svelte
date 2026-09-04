<script lang="ts">
	import { Download, MoreHorizontal, Printer, Tag, Trash2 } from '@lucide/svelte';
	import type { ScoreItem } from '../types';

	type Props = {
		score: ScoreItem;
		open?: boolean;
		onToggle: (score: ScoreItem, event: MouseEvent) => void;
		onEditTags: (score: ScoreItem, event: MouseEvent) => void;
		onDownload: (score: ScoreItem, event: MouseEvent) => void;
		onPrint: (score: ScoreItem, event: MouseEvent) => void;
		onDelete: (score: ScoreItem, event: MouseEvent) => void;
	};

	let {
		score,
		open = false,
		onToggle,
		onEditTags,
		onDownload,
		onPrint,
		onDelete
	}: Props = $props();
</script>

<div class="menu-wrap">
	<button
		type="button"
		class="action-button"
		class:active={open}
		onclick={(event) => onToggle(score, event)}
		aria-label="More actions"
		aria-expanded={open}
		title="More actions"
	>
		<MoreHorizontal size={17} strokeWidth={2} />
	</button>
	{#if open}
		<div class="score-menu" role="menu">
			<button type="button" role="menuitem" onclick={(event) => onEditTags(score, event)}>
				<Tag size={15} strokeWidth={2} />Edit tags
			</button>
			<button type="button" role="menuitem" onclick={(event) => onDownload(score, event)}>
				<Download size={15} strokeWidth={2} />Download PDF
			</button>
			<button type="button" role="menuitem" onclick={(event) => onPrint(score, event)}>
				<Printer size={15} strokeWidth={2} />Print
			</button>
			<button
				type="button"
				class="danger"
				role="menuitem"
				onclick={(event) => onDelete(score, event)}
			>
				<Trash2 size={15} strokeWidth={2} />Remove from library
			</button>
		</div>
	{/if}
</div>

<style>
	.menu-wrap {
		position: relative;
	}
	.action-button {
		width: 34px;
		height: 34px;
		display: grid;
		place-items: center;
		border: 1px solid transparent;
		border-radius: 10px;
		background: rgba(18, 18, 16, 0.72);
		color: var(--sonora-text-secondary);
		cursor: pointer;
		backdrop-filter: blur(10px);
		transition:
			background var(--sonora-duration) ease,
			color var(--sonora-duration) ease,
			border-color var(--sonora-duration) ease,
			transform var(--sonora-duration) ease;
	}
	.action-button:hover,
	.action-button.active {
		background: rgba(255, 255, 255, 0.1);
		color: var(--sonora-text);
		border-color: var(--sonora-border);
	}
	.score-menu {
		position: absolute;
		top: calc(100% + 6px);
		right: 0;
		z-index: 30;
		min-width: 196px;
		padding: 6px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-bg-panel-solid);
		backdrop-filter: var(--sonora-blur);
		box-shadow: var(--sonora-shadow-md);
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.score-menu button {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 9px 10px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--sonora-text-secondary);
		font-size: var(--sonora-text-sm);
		text-align: left;
		cursor: pointer;
		transition:
			background var(--sonora-duration) ease,
			color var(--sonora-duration) ease;
	}
	.score-menu button:hover {
		background: rgba(255, 255, 255, 0.07);
		color: var(--sonora-text);
	}
	.score-menu button.danger {
		color: #fca5a5;
	}
	.score-menu button.danger:hover {
		background: color-mix(in srgb, var(--sonora-danger) 16%, transparent);
		color: #fecaca;
	}
</style>
