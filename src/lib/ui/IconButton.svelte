<script lang="ts">
	import type { Snippet } from 'svelte';

	type Props = {
		title?: string;
		ariaLabel?: string;
		active?: boolean;
		disabled?: boolean;
		variant?: 'ghost' | 'solid' | 'danger';
		size?: 'sm' | 'md';
		class?: string;
		onclick?: (e: MouseEvent) => void;
		children?: Snippet;
	};

	let {
		title = '',
		ariaLabel = title,
		active = false,
		disabled = false,
		variant = 'ghost',
		size = 'md',
		class: className = '',
		onclick,
		children
	}: Props = $props();
</script>

<button
	type="button"
	class="sonora-icon-btn {className}"
	class:active
	class:solid={variant === 'solid'}
	class:danger={variant === 'danger'}
	class:sm={size === 'sm'}
	{title}
	aria-label={ariaLabel || undefined}
	aria-pressed={active || undefined}
	{disabled}
	{onclick}
>
	{@render children?.()}
</button>

<style>
	.sonora-icon-btn {
		width: var(--sonora-control-size);
		height: var(--sonora-control-size);
		border: 1px solid transparent;
		border-radius: var(--sonora-radius-sm);
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: var(--sonora-gap);
		transition:
			background var(--sonora-duration) ease,
			color var(--sonora-duration) ease,
			box-shadow var(--sonora-duration) ease;
		flex-shrink: 0;
	}
	.sonora-icon-btn.sm {
		width: var(--sonora-control-size-sm);
		height: var(--sonora-control-size-sm);
	}
	.sonora-icon-btn:hover:not(:disabled),
	.sonora-icon-btn.active {
		background: rgba(255, 255, 255, 0.08);
		color: var(--sonora-text);
	}
	.sonora-icon-btn.solid {
		background: var(--sonora-accent);
		color: #fff;
	}
	.sonora-icon-btn.solid:hover:not(:disabled) {
		background: color-mix(in srgb, var(--sonora-accent) 85%, white);
		color: #fff;
	}
	.sonora-icon-btn.danger:hover:not(:disabled),
	.sonora-icon-btn.danger.active {
		background: color-mix(in srgb, var(--sonora-danger) 22%, transparent);
		color: var(--sonora-danger);
	}
	.sonora-icon-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}
</style>
