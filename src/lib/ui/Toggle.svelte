<script lang="ts">
	type Props = {
		checked?: boolean;
		disabled?: boolean;
		label?: string;
		ariaLabel?: string;
		class?: string;
		onchange?: (checked: boolean) => void;
	};

	let {
		checked = $bindable(false),
		disabled = false,
		label = '',
		ariaLabel = label,
		class: className = '',
		onchange
	}: Props = $props();

	function toggle() {
		if (disabled) return;
		checked = !checked;
		onchange?.(checked);
	}
</script>

<button
	type="button"
	class="toggle {className}"
	class:on={checked}
	role="switch"
	aria-checked={checked}
	aria-label={ariaLabel || undefined}
	{disabled}
	onclick={toggle}
>
	<span class="track" aria-hidden="true">
		<span class="thumb"></span>
	</span>
	{#if label}
		<span class="label">{label}</span>
	{/if}
</button>

<style>
	.toggle {
		display: inline-flex;
		align-items: center;
		gap: 10px;
		padding: 0;
		border: 0;
		background: transparent;
		color: var(--sonora-text);
		cursor: pointer;
		font-size: var(--sonora-text-md);
	}
	.toggle:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}
	.track {
		position: relative;
		width: 42px;
		height: 24px;
		flex-shrink: 0;
		border-radius: var(--sonora-radius-pill);
		background: var(--sonora-bg-deep);
		border: 1px solid var(--sonora-border-strong);
		transition:
			background var(--sonora-duration) var(--sonora-ease),
			border-color var(--sonora-duration) var(--sonora-ease),
			box-shadow var(--sonora-duration) var(--sonora-ease);
	}
	.thumb {
		position: absolute;
		top: 2px;
		left: 2px;
		width: 18px;
		height: 18px;
		border-radius: 50%;
		background: var(--sonora-text-muted);
		box-shadow: var(--sonora-shadow-xs);
		transition:
			transform var(--sonora-duration-med) var(--sonora-ease-spring),
			background var(--sonora-duration) var(--sonora-ease);
	}
	.toggle:hover:not(:disabled) .track {
		border-color: color-mix(in srgb, var(--sonora-accent) 40%, var(--sonora-border-strong));
	}
	.toggle.on .track {
		background: var(--sonora-accent);
		border-color: transparent;
		box-shadow: var(--sonora-accent-glow);
	}
	.toggle.on .thumb {
		transform: translateX(18px);
		background: var(--sonora-accent-contrast);
	}
	.toggle:focus-visible .track {
		outline: 2px solid var(--sonora-accent);
		outline-offset: 2px;
	}
	.label {
		font-size: var(--sonora-text-md);
		color: var(--sonora-text-secondary);
	}
</style>
