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

<div
	class="list-row"
	class:opening
	role="button"
	tabindex="0"
	onclick={() => onOpen(score)}
	onkeydown={(event) => {
		if (event.key === 'Enter' || event.key === ' ') {
			event.preventDefault();
			onOpen(score);
		}
	}}
>
	<div class="list-cover">
		{#if score.thumbnailUrl}
			<img src={score.thumbnailUrl} alt="" loading="lazy" decoding="async" />
		{:else}
			<FileText size={20} strokeWidth={1.7} />
		{/if}
	</div>

	<div class="list-info">
		<strong title={score.title}>{score.title}</strong>
		<span>{score.composer}</span>
		{#if score.tags?.length}
			<div class="tags">
				{#each score.tags.slice(0, 3) as tag}
					<span>{tag}</span>
				{/each}
				{#if score.tags.length > 3}
					<small>+{score.tags.length - 3}</small>
				{/if}
			</div>
		{/if}
	</div>

	<div class="list-meta">
		<span>{score.totalPages || 1} {(score.totalPages || 1) === 1 ? 'page' : 'pages'}</span>
		{#if score.lastOpenedAt}
			<span class="recent">Recent</span>
		{/if}
	</div>

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
		grid-template-columns: 48px minmax(0, 1fr) auto auto;
		align-items: center;
		gap: 14px;
		padding: 10px 12px;
		border: 1px solid transparent;
		border-radius: var(--sonora-radius-md);
		cursor: pointer;
		transition:
			background var(--sonora-duration) ease,
			border-color var(--sonora-duration) ease;
	}
	.list-row:hover,
	.list-row:focus-visible {
		background: rgba(255, 255, 255, 0.04);
		border-color: var(--sonora-border);
		outline: none;
	}
	.list-row.opening {
		opacity: 0.7;
		pointer-events: none;
	}
	.list-cover {
		width: 48px;
		height: 62px;
		display: grid;
		place-items: center;
		overflow: hidden;
		border: 1px solid var(--sonora-border);
		border-radius: 9px;
		background: linear-gradient(160deg, #23231f 0%, #161613 100%);
		color: var(--sonora-text-muted);
		box-shadow: 0 6px 16px rgba(0, 0, 0, 0.28);
	}
	.list-cover img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: top center;
	}
	.list-info {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.list-info strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13.5px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--sonora-text);
	}
	.list-info > span {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-sm);
	}
	.tags {
		display: flex;
		flex-wrap: wrap;
		gap: 5px;
		margin-top: 3px;
	}
	.tags span,
	.tags small {
		padding: 2px 7px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid var(--sonora-border);
		color: var(--sonora-text-faint);
		font-size: 10px;
	}
	.list-meta {
		display: flex;
		flex-direction: column;
		align-items: flex-end;
		gap: 4px;
		color: var(--sonora-text-faint);
		font-size: 11px;
		white-space: nowrap;
	}
	.list-meta .recent {
		padding: 2px 7px;
		border-radius: 999px;
		background: var(--sonora-accent-soft);
		color: #93c5fd;
		font-size: 10px;
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
		background: rgba(255, 255, 255, 0.08);
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
