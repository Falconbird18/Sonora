<script lang="ts">
	import type { Snippet } from 'svelte';

	type Option = {
		value: string;
		label?: string;
		ariaLabel?: string;
		children?: Snippet;
	};

	type Props = {
		value?: string;
		options: Option[];
		ariaLabel?: string;
		class?: string;
		onchange?: (value: string) => void;
	};

	let {
		value = $bindable(''),
		options,
		ariaLabel,
		class: className = '',
		onchange
	}: Props = $props();

	function select(next: string) {
		value = next;
		onchange?.(next);
	}
</script>

<div class="seg {className}" role="group" aria-label={ariaLabel}>
	{#each options as option (option.value)}
		<button
			type="button"
			class:active={value === option.value}
			aria-label={option.ariaLabel || option.label}
			aria-pressed={value === option.value}
			onclick={() => select(option.value)}
		>
			{#if option.children}
				{@render option.children()}
			{:else}
				{option.label}
			{/if}
		</button>
	{/each}
</div>

<style>
	.seg {
		display: inline-flex;
		gap: 2px;
		padding: 3px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: color-mix(in srgb, var(--sonora-bg-elevated) 90%, transparent);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.03);
	}
	button {
		min-width: 32px;
		height: 30px;
		padding: 0 8px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-sm);
		cursor: pointer;
		transition:
			background var(--sonora-duration) ease,
			color var(--sonora-duration) ease,
			box-shadow var(--sonora-duration) ease;
	}
	button:hover {
		color: var(--sonora-text);
		background: rgba(255, 255, 255, 0.06);
	}
	button.active {
		background: rgba(255, 255, 255, 0.1);
		color: var(--sonora-text);
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.25);
	}
</style>
