<script lang="ts">
	import type { Snippet } from 'svelte';

	type Props = {
		title?: string;
		primary?: boolean;
		disabled?: boolean;
		class?: string;
		onclick?: (e: MouseEvent) => void;
		children?: Snippet;
	};

	let {
		title = '',
		primary = false,
		disabled = false,
		class: className = '',
		onclick,
		children
	}: Props = $props();
</script>

<button
	type="button"
	class="sonora-text-btn {className}"
	class:primary
	{title}
	{disabled}
	{onclick}
>
	{@render children?.()}
</button>

<style>
	.sonora-text-btn {
		min-height: var(--sonora-control-size);
		padding: 7px 10px;
		border: 1px solid transparent;
		border-radius: var(--sonora-radius-sm);
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--sonora-gap);
		font-size: var(--sonora-text-sm);
		transition:
			background var(--sonora-duration) ease,
			color var(--sonora-duration) ease;
	}
	.sonora-text-btn:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.08);
		color: var(--sonora-text);
	}
	.sonora-text-btn.primary {
		background: rgba(255, 255, 255, 0.06);
		color: var(--sonora-text);
	}
	.sonora-text-btn.primary:hover:not(:disabled) {
		background: rgba(255, 255, 255, 0.12);
	}
	.sonora-text-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}
</style>
