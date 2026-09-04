<script lang="ts">
	import { Check, X } from '@lucide/svelte';
	import type { Snippet } from 'svelte';

	type Props = {
		variant?: 'info' | 'error' | 'success';
		dismissible?: boolean;
		ondismiss?: () => void;
		children?: Snippet;
		class?: string;
	};

	let {
		variant = 'info',
		dismissible = false,
		ondismiss,
		children,
		class: className = ''
	}: Props = $props();
</script>

<div class="notice {className}" class:error={variant === 'error'} class:success={variant === 'success'} role="status">
	{#if variant === 'success'}
		<span class="lead"><Check size={15} strokeWidth={2.25} /></span>
	{/if}
	<div class="body">{@render children?.()}</div>
	{#if dismissible}
		<button type="button" class="dismiss" onclick={() => ondismiss?.()} aria-label="Dismiss">
			<X size={15} strokeWidth={2.25} />
		</button>
	{/if}
</div>

<style>
	.notice {
		display: flex;
		align-items: center;
		gap: 10px;
		margin: 0 28px;
		padding: 10px 14px;
		border: 1px solid var(--sonora-border);
		border-radius: var(--sonora-radius-md);
		background: color-mix(in srgb, var(--sonora-bg-elevated) 92%, transparent);
		color: var(--sonora-text-secondary);
		font-size: var(--sonora-text-sm);
		box-shadow: var(--sonora-shadow-sm);
	}
	.notice.error {
		border-color: color-mix(in srgb, var(--sonora-danger) 35%, transparent);
		background: color-mix(in srgb, var(--sonora-danger) 12%, var(--sonora-bg-elevated));
		color: #fecaca;
	}
	.notice.success {
		border-color: color-mix(in srgb, var(--sonora-success) 30%, transparent);
		background: color-mix(in srgb, var(--sonora-success) 10%, var(--sonora-bg-elevated));
		color: #bbf7d0;
	}
	.lead {
		display: grid;
		place-items: center;
		flex-shrink: 0;
	}
	.body {
		min-width: 0;
		flex: 1;
	}
	.dismiss {
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: inherit;
		opacity: 0.75;
		cursor: pointer;
		transition:
			background var(--sonora-duration) ease,
			opacity var(--sonora-duration) ease;
	}
	.dismiss:hover {
		background: rgba(255, 255, 255, 0.08);
		opacity: 1;
	}
	@media (max-width: 900px) {
		.notice {
			margin: 0 18px;
		}
	}
	@media (max-width: 680px) {
		.notice {
			margin: 0 12px;
		}
	}
</style>
