<script lang="ts">
	import { Check } from '@lucide/svelte';
	import type { Snippet } from 'svelte';
	let {
		label,
		selected = false,
		selecting = false,
		list = false,
		onToggle,
		onPointerDown,
		dropId,
		draggable = false,
		onDragStart,
		onDragEnd,
		dropActive = false,
		onDragOver,
		onDragLeave,
		onDrop,
		children
	}: {
		label: string;
		selected?: boolean;
		selecting?: boolean;
		list?: boolean;
		draggable?: boolean;
		dropId?: string;
		onPointerDown?: (event: PointerEvent) => void;
		dropActive?: boolean;
		onDragStart?: (event: DragEvent) => void;
		onDragEnd?: () => void;
		onDragOver?: (event: DragEvent) => void;
		onDragLeave?: () => void;
		onDrop?: (event: DragEvent) => void;
		onToggle: () => void;
		children: Snippet;
	} = $props();
</script>

<div
	class="entry"
	role="group"
	aria-label={label.replace(/^Select /, '')}
	class:selected
	class:selecting
	class:list
	class:dropActive
	{draggable}
	data-folder-drop={dropId}
	onpointerdown={onPointerDown}
	ondragstart={onDragStart}
	ondragend={onDragEnd}
	ondragover={onDragOver}
	ondragleave={onDragLeave}
	ondrop={onDrop}>
	<button
		class="selection"
		role="checkbox"
		aria-checked={selected}
		aria-label={label}
		onclick={onToggle}>
		{#if selected}<Check size={14} strokeWidth={2.6} />{/if}
	</button>
	<div class="content">{@render children()}</div>
</div>

<style>
	.entry {
		position: relative;
		user-select: none;
		min-width: 0;
		border-radius: var(--sonora-radius-lg);
	}
	.entry.dropActive {
		outline: 2px solid var(--sonora-accent);
		outline-offset: 3px;
		background: var(--sonora-accent-soft);
	}
	.entry.selected {
		box-shadow: 0 0 0 2px var(--sonora-accent);
		background: var(--sonora-accent-soft);
	}
	.content {
		min-width: 0;
	}
	.selection {
		position: absolute;
		top: 12px;
		left: 12px;
		z-index: 3;
		width: 24px;
		height: 24px;
		padding: 0;
		display: grid;
		place-items: center;
		border-radius: 50%;
		border: 1.5px solid var(--sonora-border-strong);
		background: var(--sonora-bg-elevated);
		color: var(--sonora-text);
		box-shadow: 0 1px 5px #0002;
		cursor: pointer;
		opacity: 0;
		transition:
			opacity 120ms,
			background 120ms,
			border-color 120ms;
	}
	.entry:hover .selection,
	.entry:focus-within .selection,
	.entry.selecting .selection {
		opacity: 1;
	}
	.selected .selection {
		opacity: 1;
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
		border-color: var(--sonora-accent);
	}
	.selection:focus-visible {
		outline: 2px solid var(--sonora-accent);
		outline-offset: 3px;
		opacity: 1;
	}
	.entry.list {
		display: grid;
		grid-template-columns: 36px minmax(0, 1fr);
		align-items: center;
	}
	.list .selection {
		position: relative;
		top: auto;
		left: auto;
		justify-self: center;
		width: 20px;
		height: 20px;
		box-shadow: none;
		opacity: 0.6;
	}
	.list:hover .selection,
	.list.selected .selection {
		opacity: 1;
	}
	@media (hover: none) {
		.selection {
			opacity: 1;
		}
	}
</style>
