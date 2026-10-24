<script lang="ts">
	import type { Snippet } from 'svelte';
	import { X } from '@lucide/svelte';
	let {
		title,
		eyebrow = '',
		onClose,
		children
	}: {
		title: string;
		eyebrow?: string;
		onClose: () => void;
		children: Snippet;
	} = $props();
</script>

<aside class="viewer-panel" aria-label={title}>
	<header>
		<div>
			{#if eyebrow}<span class="eyebrow">{eyebrow}</span>{/if}
			<h2>{title}</h2>
		</div>
		<button
			class="close"
			onclick={onClose}
			aria-label={`Close ${title.toLowerCase()}`}
			title="Close"><X size={17} /></button>
	</header>
	{@render children()}
</aside>

<style>
	.viewer-panel {
		position: absolute;
		right: 16px;
		top: 76px;
		z-index: 45;
		width: 320px;
		max-width: calc(100% - 32px);
		max-height: calc(100% - 100px);
		overflow: auto;
		color: var(--sonora-text);
		background: var(--sonora-bg-panel-solid);
		border: 1px solid var(--sonora-border-strong);
		border-radius: 22px;
		box-shadow:
			0 18px 60px #0004,
			0 2px 8px #0002;
		font-family: var(--sonora-font-ui, Inter, system-ui, sans-serif);
		animation: panel-in 160ms ease-out;
		isolation: isolate;
	}
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 22px 22px 0;
		gap: 12px;
	}
	.eyebrow {
		display: block;
		text-transform: uppercase;
		letter-spacing: 0.16em;
		font-size: 9px;
		font-weight: 600;
		color: var(--sonora-text-muted);
		margin-bottom: 5px;
	}
	h2 {
		font: 600 17px/1.3 var(--sonora-font-ui, Inter, system-ui, sans-serif);
		letter-spacing: -0.03em;
		margin: 0;
	}
	.close {
		width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 50%;
		color: var(--sonora-text-muted);
		background: var(--sonora-bg-hover);
		cursor: pointer;
	}
	.close:hover {
		background: var(--sonora-bg-active);
		color: var(--sonora-text);
	}
	.close:focus-visible {
		outline: 2px solid var(--sonora-accent);
		outline-offset: 3px;
	}
	@keyframes panel-in {
		from {
			opacity: 0;
			transform: translateY(-5px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.viewer-panel {
			animation: none;
		}
	}
	:global(.reduce-motion) .viewer-panel {
		animation: none;
	}
	@media (max-width: 650px) {
		.viewer-panel {
			top: 112px;
			right: 12px;
			max-height: calc(100% - 190px);
		}
	}
	@media print {
		.viewer-panel {
			display: none;
		}
	}
</style>
