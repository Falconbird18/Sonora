<script lang="ts">
	import { Check, X, AlertCircle, Info } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	import { fade, fly } from 'svelte/transition';

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

<div
	class="toast-host"
	in:fly={{ y: -16, duration: 320, opacity: 0 }}
	out:fade={{ duration: 200 }}
>
	<div
		class="notice {className}"
		class:error={variant === 'error'}
		class:success={variant === 'success'}
		class:info={variant === 'info'}
		role="status"
	>
		<span class="lead" aria-hidden="true">
			{#if variant === 'success'}
				<Check size={16} strokeWidth={2.4} />
			{:else if variant === 'error'}
				<AlertCircle size={16} strokeWidth={2.2} />
			{:else}
				<Info size={16} strokeWidth={2.2} />
			{/if}
		</span>
		<div class="body">{@render children?.()}</div>
		{#if dismissible}
			<button type="button" class="dismiss" onclick={() => ondismiss?.()} aria-label="Dismiss">
				<X size={15} strokeWidth={2.25} />
			</button>
		{/if}
	</div>
</div>

<style>
	.toast-host {
		position: fixed;
		top: calc(16px + env(safe-area-inset-top, 0px));
		left: 50%;
		transform: translateX(-50%);
		z-index: 90;
		width: min(420px, calc(100% - 32px));
		pointer-events: none;
	}
	.notice {
		pointer-events: auto;
		display: flex;
		align-items: center;
		gap: 12px;
		padding: 12px 14px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-lg);
		background: var(--sonora-toast-bg);
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
		color: var(--sonora-text-secondary);
		font-size: var(--sonora-text-md);
		box-shadow: var(--sonora-shadow-md);
		letter-spacing: -0.01em;
	}
	.notice.success {
		border-color: color-mix(in srgb, var(--sonora-success) 40%, var(--sonora-border));
		box-shadow:
			var(--sonora-shadow-md),
			0 0 0 1px color-mix(in srgb, var(--sonora-success) 20%, transparent);
	}
	.notice.success .lead {
		color: var(--sonora-success);
		background: var(--sonora-success-soft);
	}
	.notice.error {
		border-color: color-mix(in srgb, var(--sonora-danger) 40%, var(--sonora-border));
		box-shadow:
			var(--sonora-shadow-md),
			0 0 0 1px color-mix(in srgb, var(--sonora-danger) 18%, transparent);
	}
	.notice.error .lead {
		color: var(--sonora-danger);
		background: var(--sonora-danger-soft);
	}
	.notice.info .lead {
		color: var(--sonora-accent);
		background: var(--sonora-accent-soft);
	}
	.lead {
		width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		flex-shrink: 0;
		border-radius: 10px;
	}
	.body {
		min-width: 0;
		flex: 1;
		line-height: 1.35;
	}
	.dismiss {
		width: 30px;
		height: 30px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 9px;
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
		transition:
			background var(--sonora-duration) var(--sonora-ease),
			color var(--sonora-duration) var(--sonora-ease);
	}
	.dismiss:hover {
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
	}
</style>
