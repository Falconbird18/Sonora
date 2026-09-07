<script lang="ts">
	import { FileText, Star } from '@lucide/svelte';
	import type { ScoreItem } from '../types';
	import ScoreActionsMenu from './ScoreActionsMenu.svelte';

	type Props = {
		score: ScoreItem;
		opening?: boolean;
		menuOpen?: boolean;
		onOpen: (score: ScoreItem) => void;
		onToggleFavorite: (score: ScoreItem, event: MouseEvent) => void;
		onToggleMenu: (score: ScoreItem, event: MouseEvent) => void;
		onEditTags: (score: ScoreItem, event: MouseEvent) => void;
		onDownload: (score: ScoreItem, event: MouseEvent) => void;
		onPrint: (score: ScoreItem, event: MouseEvent) => void;
		onDelete: (score: ScoreItem, event: MouseEvent) => void;
	};

	let {
		score,
		opening = false,
		menuOpen = false,
		onOpen,
		onToggleFavorite,
		onToggleMenu,
		onEditTags,
		onDownload,
		onPrint,
		onDelete
	}: Props = $props();
</script>

<div class="list-row" class:opening>
	<button type="button" class="list-open" onclick={() => onOpen(score)} aria-label={`Open ${score.title}`}>
		<div class="list-cover">
			{#if score.thumbnailUrl}
				<img src={score.thumbnailUrl} alt="" loading="eager" decoding="async" />
			{:else}
				<div class="no-cover"><FileText size={18} strokeWidth={1.6} /></div>
			{/if}
		</div>
		<div class="list-info">
			<h3 title={score.title}>{score.title}</h3>
			<p>{score.composer}</p>
			{#if score.tags?.length}
				<div class="tags">
					{#each score.tags.slice(0, 3) as tag}
						<span>{tag}</span>
					{/each}
				</div>
			{/if}
		</div>
		<div class="list-meta">
			{#if score.totalPages}
				<span>{score.totalPages}p</span>
			{/if}
		</div>
	</button>
	<div class="list-actions">
		<button
			type="button"
			class="action-button favorite"
			class:marked={score.favorite}
			onclick={(event) => onToggleFavorite(score, event)}
			aria-label={score.favorite ? 'Remove from favorites' : 'Add to favorites'}
			aria-pressed={score.favorite}
			title={score.favorite ? 'Remove from favorites' : 'Add to favorites'}
		>
			<Star size={16} strokeWidth={2} fill={score.favorite ? 'currentColor' : 'none'} />
		</button>
		<ScoreActionsMenu
			{score}
			open={menuOpen}
			onToggle={onToggleMenu}
			onEditTags={onEditTags}
			onDownload={onDownload}
			onPrint={onPrint}
			onDelete={onDelete}
		/>
	</div>
</div>

<style>
	.list-row {
		display: grid;
		grid-template-columns: 1fr auto;
		align-items: center;
		gap: 8px;
		padding: 8px 10px;
		border-radius: var(--sonora-radius-md);
		border: 1px solid transparent;
		transition:
			background var(--sonora-duration) ease,
			border-color var(--sonora-duration) ease;
	}
	.list-row:hover,
	.list-row:focus-within {
		background: var(--sonora-bg-hover);
		border-color: var(--sonora-border);
	}
	.list-row.opening {
		opacity: 0.7;
		pointer-events: none;
	}
	.list-open {
		display: grid;
		grid-template-columns: 48px minmax(0, 1fr) auto;
		align-items: center;
		gap: 12px;
		min-width: 0;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}
	.list-cover {
		width: 48px;
		height: 64px;
		overflow: hidden;
		border-radius: 8px;
		border: 1px solid var(--sonora-border);
		background: #1a1a17;
	}
	.list-cover img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: top center;
	}
	.no-cover {
		height: 100%;
		display: grid;
		place-items: center;
		color: var(--sonora-text-muted);
	}
	.list-info {
		min-width: 0;
	}
	.list-info h3 {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13.5px;
		font-weight: 600;
	}
	.list-info p {
		margin: 2px 0 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-sm);
	}
	.list-info .tags {
		display: flex;
		flex-wrap: wrap;
		gap: 4px;
		margin-top: 6px;
	}
	.list-info .tags span {
		padding: 2px 6px;
		border-radius: 999px;
		background: var(--sonora-accent-soft);
		color: #93c5fd;
		font-size: 10px;
	}
	.list-meta {
		color: var(--sonora-text-faint);
		font-size: 11px;
	}
	.list-actions {
		display: flex;
		align-items: center;
		gap: 4px;
	}
	.action-button {
		width: 34px;
		height: 34px;
		display: grid;
		place-items: center;
		border: 1px solid transparent;
		border-radius: 10px;
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
		transition:
			background var(--sonora-duration) ease,
			color var(--sonora-duration) ease;
	}
	.action-button:hover {
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
	}
	.action-button.favorite.marked {
		color: #fbbf24;
	}
	@media (max-width: 680px) {
		.list-row {
			grid-template-columns: 42px minmax(0, 1fr) auto;
			gap: 10px;
		}
		.list-meta {
			display: none;
		}
		.list-cover {
			width: 42px;
			height: 54px;
		}
		.list-info .tags {
			display: none;
		}
	}
</style>
