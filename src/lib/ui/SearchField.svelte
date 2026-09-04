<script lang="ts">
	import { Search, X } from '@lucide/svelte';

	type Props = {
		value?: string;
		placeholder?: string;
		ariaLabel?: string;
		class?: string;
		onclear?: () => void;
	};

	let {
		value = $bindable(''),
		placeholder = 'Search…',
		ariaLabel = 'Search',
		class: className = '',
		onclear
	}: Props = $props();

	function clear(event: MouseEvent) {
		event.stopPropagation();
		value = '';
		onclear?.();
	}
</script>

<div class="search-field {className}" class:has-value={!!value}>
	<span class="icon" aria-hidden="true"><Search size={17} strokeWidth={2} /></span>
	<input bind:value {placeholder} aria-label={ariaLabel} type="search" autocomplete="off" />
	{#if value}
		<button type="button" class="clear" onclick={clear} aria-label="Clear search">
			<X size={15} strokeWidth={2.25} />
		</button>
	{/if}
</div>

<style>
	.search-field {
		height: 42px;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 0 12px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: color-mix(in srgb, var(--sonora-bg-elevated) 88%, transparent);
		color: var(--sonora-text-muted);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
		transition:
			border-color var(--sonora-duration) ease,
			background var(--sonora-duration) ease,
			box-shadow var(--sonora-duration) ease;
	}
	.search-field:focus-within {
		border-color: color-mix(in srgb, var(--sonora-accent) 55%, var(--sonora-border-strong));
		background: var(--sonora-bg-elevated);
		box-shadow:
			inset 0 1px 0 rgba(255, 255, 255, 0.04),
			0 0 0 3px var(--sonora-accent-soft);
		color: var(--sonora-text-secondary);
	}
	.icon {
		display: grid;
		place-items: center;
		flex-shrink: 0;
		opacity: 0.9;
	}
	input {
		min-width: 0;
		flex: 1;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--sonora-text);
		font-size: var(--sonora-text-md);
		letter-spacing: -0.01em;
	}
	input::placeholder {
		color: var(--sonora-text-faint);
	}
	input::-webkit-search-decoration,
	input::-webkit-search-cancel-button {
		display: none;
	}
	.clear {
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
		transition:
			background var(--sonora-duration) ease,
			color var(--sonora-duration) ease;
	}
	.clear:hover {
		background: rgba(255, 255, 255, 0.08);
		color: var(--sonora-text);
	}
</style>
