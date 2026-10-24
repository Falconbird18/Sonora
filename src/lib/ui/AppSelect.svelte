<script lang="ts">
	import { tick } from 'svelte';
	import { Check, ChevronDown } from '@lucide/svelte';
	let {
		value = $bindable(''),
		options,
		label,
		onchange
	}: {
		value?: string;
		options: { value: string; label: string }[];
		label: string;
		onchange?: (value: string) => void;
	} = $props();
	let open = $state(false);
	let host: HTMLDivElement;
	let trigger: HTMLButtonElement;
	let choices = $state<HTMLDivElement>();
	let active = $state(0);
	const selected = $derived(options.find((option) => option.value === value));
	async function show(
		index = Math.max(
			0,
			options.findIndex((option) => option.value === value)
		)
	) {
		open = true;
		active = index;
		await tick();
		choices?.querySelectorAll<HTMLButtonElement>('button')[active]?.focus();
	}
	function close(restore = false) {
		open = false;
		if (restore) trigger?.focus();
	}
	function select(index: number) {
		value = options[index].value;
		onchange?.(value);
		close(true);
	}
	function keys(event: KeyboardEvent) {
		if (
			['ArrowDown', 'ArrowUp', 'Home', 'End', 'Escape', 'Enter', ' '].includes(
				event.key
			)
		)
			event.preventDefault();
		if (event.key === 'Escape') {
			event.stopPropagation();
			close(true);
			return;
		}
		if (event.key === 'Tab') {
			close();
			return;
		}
		if (!open && ['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
			void show();
			return;
		}
		if (!open) return;
		if (event.key === 'Enter' || event.key === ' ') {
			select(active);
			return;
		}
		if (event.key === 'ArrowDown') active = (active + 1) % options.length;
		else if (event.key === 'ArrowUp')
			active = (active - 1 + options.length) % options.length;
		else if (event.key === 'Home') active = 0;
		else if (event.key === 'End') active = options.length - 1;
		else if (event.key.length === 1) {
			const found = options.findIndex((o) =>
				o.label.toLowerCase().startsWith(event.key.toLowerCase())
			);
			if (found >= 0) active = found;
		}
		choices?.querySelectorAll<HTMLButtonElement>('button')[active]?.focus();
	}
</script>

<svelte:window
	onpointerdown={(event) => {
		if (open && !host.contains(event.target as Node)) close();
	}} />
<div class="app-select" bind:this={host}>
	<button
		class="trigger"
		bind:this={trigger}
		aria-label={`${label}: ${selected?.label || 'None'}`}
		aria-haspopup="listbox"
		aria-expanded={open}
		onclick={() => (open ? close() : void show())}
		onkeydown={keys}
		>{selected?.label || 'Choose…'}<ChevronDown size={15} /></button>
	{#if open}<div
			class="options"
			role="listbox"
			aria-label={label}
			bind:this={choices}
			tabindex="-1"
			onkeydown={keys}>
			{#each options as option, index}<button
					role="option"
					aria-selected={value === option.value}
					tabindex={active === index ? 0 : -1}
					class:chosen={value === option.value}
					onclick={() => select(index)}
					>{option.label}{#if value === option.value}<Check
							size={15} />{/if}</button
				>{/each}
		</div>{/if}
</div>

<style>
	.app-select {
		position: relative;
		min-width: 140px;
		font-size: var(--sonora-text-sm);
	}
	.trigger {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 14px;
		width: 100%;
		min-height: var(--sonora-control-size);
		padding: 8px 12px;
		color: var(--sonora-text-secondary);
		background: var(--sonora-surface-raised);
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		box-shadow: var(--sonora-inset), var(--sonora-shadow-xs);
		cursor: pointer;
	}
	.options {
		position: absolute;
		right: 0;
		top: calc(100% + 6px);
		z-index: 60;
		min-width: max(100%, 180px);
		padding: 5px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-bg-panel);
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
		box-shadow: var(--sonora-inset), var(--sonora-shadow-md);
	}
	.options button {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 20px;
		width: 100%;
		padding: 9px 12px;
		min-height: var(--sonora-control-size);
		border: 0;
		border-radius: var(--sonora-radius-sm);
		background: transparent;
		color: var(--sonora-text);
		text-align: left;
		cursor: pointer;
	}
	.options button:hover,
	.options button:focus-visible,
	.chosen {
		background: var(--sonora-accent-soft);
		color: var(--sonora-accent);
	}
</style>
