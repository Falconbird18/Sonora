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

<article class="card" class:opening>
	<button
		type="button"
		class="score-open"
		onclick={() => onOpen(score)}
		aria-label={`Open ${score.title}`}
	>
		<div class="cover">
			{#if score.thumbnailUrl}
				<img src={score.thumbnailUrl} alt="" loading="eager" decoding="async" />
			{:else}
				<div class="no-cover">
					<FileText size={26} strokeWidth={1.6} />
					<span>
						{score.totalPages ? `${score.totalPages} pages` : 'Preparing preview'}
					</span>
				</div>
			{/if}
			<div class="cover-shine" aria-hidden="true"></div>
		</div>
		<div class="info">
			<h3 title={score.title}>{score.title}</h3>
			<p>{score.composer}</p>
			{#if score.tags?.length}
				<div class="tags">
					{#each score.tags.slice(0, 2) as tag}
						<span>{tag}</span>
					{/each}
					{#if score.tags.length > 2}
						<small>+{score.tags.length - 2}</small>
					{/if}
				</div>
			{/if}
		</div>
	</button>

	<div class="card-actions">
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
</article>

<style>
	.card {
		position: relative;
		display: flex;
		flex-direction: column;
		gap: 0;
		border-radius: var(--sonora-radius-lg);
		transition: transform var(--sonora-duration-med) var(--sonora-ease);
	}
	.card:hover {
		transform: translateY(-2px);
	}
	.card.opening {
		opacity: 0.72;
		pointer-events: none;
	}
	.score-open {
		display: flex;
		flex-direction: column;
		gap: 12px;
		width: 100%;
		padding: 0;
		border: 0;
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}
	.cover {
		position: relative;
		aspect-ratio: 3 / 4;
		overflow: hidden;
		border: 1px solid var(--sonora-border);
		border-radius: var(--sonora-radius-lg);
		background: linear-gradient(160deg, #23231f 0%, #161613 100%);
		box-shadow:
			0 10px 28px rgba(0, 0, 0, 0.35),
			inset 0 1px 0 rgba(255, 255, 255, 0.04);
	}
	.cover img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: top center;
		transition: transform 320ms var(--sonora-ease);
	}
	.card:hover .cover img {
		transform: scale(1.03);
	}
	.cover-shine {
		pointer-events: none;
		position: absolute;
		inset: 0;
		background: linear-gradient(
			180deg,
			rgba(255, 255, 255, 0.06) 0%,
			transparent 28%,
			transparent 72%,
			rgba(0, 0, 0, 0.18) 100%
		);
	}
	.no-cover {
		height: 100%;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 10px;
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-xs);
		letter-spacing: 0.02em;
	}
	.info {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-width: 0;
		padding: 0 2px;
	}
	.info h3 {
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-size: 13.5px;
		font-weight: 600;
		letter-spacing: -0.02em;
		color: var(--sonora-text);
	}
	.info p {
		margin: 0;
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
		margin-top: 4px;
	}
	.tags span,
	.tags small {
		padding: 3px 7px;
		border-radius: 999px;
		background: rgba(255, 255, 255, 0.05);
		border: 1px solid var(--sonora-border);
		color: var(--sonora-text-faint);
		font-size: 10px;
		line-height: 1.2;
	}
	.card-actions {
		position: absolute;
		top: 10px;
		right: 10px;
		display: flex;
		gap: 6px;
		opacity: 0;
		transform: translateY(-4px);
		transition:
			opacity var(--sonora-duration) ease,
			transform var(--sonora-duration) ease;
	}
	.card:hover .card-actions,
	.card:focus-within .card-actions {
		opacity: 1;
		transform: translateY(0);
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
			border-color var(--sonora-duration) ease;
	}
	.action-button:hover {
		background: rgba(255, 255, 255, 0.1);
		color: var(--sonora-text);
		border-color: var(--sonora-border);
	}
	.action-button.favorite.marked {
		color: #fbbf24;
	}
	@media (pointer: coarse) {
		.card-actions {
			opacity: 1;
			transform: none;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.card,
		.cover img,
		.card-actions {
			transition: none;
		}
	}
</style>
