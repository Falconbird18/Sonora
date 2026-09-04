<script lang="ts">
	import type { Snippet } from 'svelte';

	type Props = {
		class?: string;
		role?: string;
		ariaLabel?: string;
		children?: Snippet;
	};

	let { class: className = '', role, ariaLabel, children }: Props = $props();
</script>

<div class="sonora-glass-bar {className}" {role} aria-label={ariaLabel}>
	{@render children?.()}
</div>

<style>
	.sonora-glass-bar {
		display: flex;
		align-items: center;
		gap: var(--sonora-gap);
		padding: var(--sonora-gap);
		border: 1px solid var(--sonora-border);
		border-radius: var(--sonora-radius-lg);
		background: var(--sonora-bg-panel);
		backdrop-filter: var(--sonora-blur);
		box-shadow: var(--sonora-shadow-md);
	}
</style>
