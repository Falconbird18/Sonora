<script lang="ts">
	import {
		Eye,
		EyeOff,
		ChevronUp,
		ChevronDown,
		Plus,
		Check
	} from '@lucide/svelte';
	import type { AnnotationLayer } from '../types';
	import ViewerPanel from './ViewerPanel.svelte';
	let {
		layers,
		activeLayer,
		onSelect,
		onRename,
		onVisibility,
		onMove,
		onAdd,
		onClose,
		error = ''
	}: {
		layers: AnnotationLayer[];
		activeLayer: string;
		onSelect: (id: string) => void;
		onRename: (id: string, name: string) => void;
		onVisibility: (id: string) => void;
		onMove: (index: number, direction: number) => void;
		onAdd: () => void;
		onClose: () => void;
		error?: string;
	} = $props();
</script>

<ViewerPanel title="Layers" eyebrow="Annotations" {onClose}>
	<div class="layer-list" role="group" aria-label="Annotation layers">
		{#each layers as layer, i (layer.id)}
			<div
				class="layer"
				class:selected={activeLayer === layer.id}
				class:muted={!layer.visible}>
				<button
					class="select-layer"
					aria-label={`Edit ${layer.name}`}
					aria-pressed={activeLayer === layer.id}
					onclick={() => onSelect(layer.id)}
					title={`Draw on ${layer.name}`}
					><span class="selection"
						>{#if activeLayer === layer.id}<Check
								size={11}
								strokeWidth={3} />{/if}</span
					></button>
				<div class="layer-name">
					<input
						aria-label={`Name of ${layer.name} layer`}
						value={layer.name}
						onchange={(e) => onRename(layer.id, e.currentTarget.value)}
						onfocus={() => onSelect(layer.id)} /><span
						>{activeLayer === layer.id
							? layer.visible
								? 'Selected for editing'
								: 'Hidden · editing paused'
							: 'Annotation layer'}</span>
				</div>
				<button
					class="visibility"
					aria-label={`${layer.visible ? 'Hide' : 'Show'} ${layer.name}`}
					title={layer.visible ? 'Hide layer' : 'Show layer'}
					aria-pressed={layer.visible}
					onclick={() => onVisibility(layer.id)}
					>{#if layer.visible}<Eye size={16} />{:else}<EyeOff
							size={16} />{/if}</button>
				<div class="reorder">
					<button
						aria-label={`Move ${layer.name} up`}
						title="Move layer up"
						disabled={i === 0}
						onclick={() => onMove(i, -1)}><ChevronUp size={13} /></button
					><button
						aria-label={`Move ${layer.name} down`}
						title="Move layer down"
						disabled={i === layers.length - 1}
						onclick={() => onMove(i, 1)}><ChevronDown size={13} /></button>
				</div>
			</div>
		{/each}
	</div>
	<footer>
		<button class="add" onclick={onAdd}><Plus size={15} />New layer</button
		><span>Top layers draw on top</span>
	</footer>
	{#if error}<p role="alert">{error}</p>{/if}
</ViewerPanel>

<style>
	.layer-list {
		padding: 20px 12px 12px;
		display: grid;
		gap: 4px;
	}
	.layer {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 8px;
		border-radius: 11px;
		border: 1px solid transparent;
		transition: background 120ms;
	}
	.layer:hover {
		background: var(--sonora-bg-hover);
	}
	.layer.selected {
		background: var(--sonora-accent-soft);
		border-color: var(--sonora-border-focus);
	}
	button {
		display: grid;
		place-items: center;
		color: var(--sonora-text-muted);
		border: 0;
		background: transparent;
		border-radius: 6px;
		cursor: pointer;
		padding: 0;
	}
	button:hover {
		color: var(--sonora-text);
		background: var(--sonora-bg-hover);
	}
	button:focus-visible,
	input:focus-visible {
		outline: 2px solid var(--sonora-accent);
		outline-offset: 2px;
	}
	.select-layer {
		width: 24px;
		height: 36px;
		flex-shrink: 0;
	}
	.selection {
		display: grid;
		place-items: center;
		width: 14px;
		height: 14px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 50%;
	}
	.selected .selection {
		background: var(--sonora-accent);
		border-color: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
	}
	.layer-name {
		flex: 1;
		min-width: 0;
		display: grid;
		gap: 3px;
	}
	.layer-name input {
		font-family: inherit;
		font-size: 12px;
		font-weight: 500;
		line-height: 1.4;
		background: transparent;
		color: var(--sonora-text);
		border: 0;
		width: 100%;
		padding: 0;
		outline-offset: 4px;
		text-overflow: ellipsis;
	}
	.layer-name span {
		font-size: 9px;
		color: var(--sonora-text-muted);
	}
	.muted .layer-name input {
		color: var(--sonora-text-muted);
	}
	.visibility {
		width: 28px;
		height: 32px;
		flex-shrink: 0;
	}
	.reorder {
		display: grid;
		gap: 0;
	}
	.reorder button {
		width: 20px;
		height: 18px;
	}
	.reorder button:disabled {
		opacity: 0.2;
		cursor: default;
	}
	footer {
		border-top: 1px solid var(--sonora-border);
		padding: 15px 20px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}
	.add {
		display: flex;
		align-items: center;
		gap: 7px;
		font-family: inherit;
		font-size: 11px;
		font-weight: 500;
		line-height: 1.4;
		padding: 4px 0;
		color: var(--sonora-text);
	}
	footer > span {
		font-size: 9px;
		color: var(--sonora-text-muted);
	}
	p {
		padding: 0 20px 16px;
		font-size: 11px;
		color: var(--sonora-danger);
	}
</style>
