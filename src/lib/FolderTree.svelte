<script lang="ts">
	import { ChevronRight, Folder, FolderOpen, MoreHorizontal } from 'lucide-svelte';
	import type { FolderTreeNode } from './folderTree';

	export let nodes: FolderTreeNode[] = [];
	export let selectedId = '';
	export let onSelect: (folder: FolderTreeNode) => void = () => {};
	export let onMenu: (folder: FolderTreeNode) => void = () => {};
	export let onDrop: (folder: FolderTreeNode, event: DragEvent) => void = () => {};

	let expanded = new Set<string>();
	let dragOverId = '';

	function toggle(id: string) {
		expanded = new Set(expanded);
		if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
	}

	function handleKeydown(event: KeyboardEvent, node: FolderTreeNode) {
		if (event.key === 'ArrowRight' && node.children.length) { if (!expanded.has(node.id)) toggle(node.id); }
		else if (event.key === 'ArrowLeft') { if (expanded.has(node.id)) toggle(node.id); }
		else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(node); }
	}

	function drop(node: FolderTreeNode, event: DragEvent) {
		event.preventDefault(); dragOverId = ''; onDrop(node, event);
	}
</script>

<nav class="folder-tree" aria-label="Folders">
	{#each nodes as node (node.id)}
		{@const isExpanded = expanded.has(node.id)}
		{@const hasChildren = node.children.length > 0}
		<div class="folder-branch">
			<div class:selected={selectedId === node.id} class:drag-over={dragOverId === node.id} class="folder-row" style={`--depth:${node.depth}`} ondragover={(event) => { event.preventDefault(); dragOverId = node.id; }} ondragleave={() => { if (dragOverId === node.id) dragOverId = ''; }} ondrop={(event) => drop(node, event)}>
				<button class="disclosure" aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`} disabled={!hasChildren} onclick={() => toggle(node.id)}>
					<ChevronRight size={15} class:rotated={isExpanded} />
				</button>
				<button class="folder-button" aria-current={selectedId === node.id ? 'page' : undefined} aria-label={`${node.name}${node.scoreCount ? `, ${node.scoreCount} scores` : ''}`} onclick={() => onSelect(node)} onkeydown={(event) => handleKeydown(event, node)}>
					{#if isExpanded && hasChildren}<FolderOpen size={17} />{:else}<Folder size={17} />{/if}
					<span>{node.name}</span>
					{#if node.scoreCount}<small>{node.scoreCount}</small>{/if}
				</button>
				<button class="menu" aria-label={`Options for ${node.name}`} onclick={() => onMenu(node)}><MoreHorizontal size={17} /></button>
			</div>
			{#if isExpanded && hasChildren}
				<svelte:self nodes={node.children} {selectedId} {onSelect} {onMenu} {onDrop} />
			{/if}
		</div>
	{/each}
</nav>

<style>
	.folder-tree { display:flex; flex-direction:column; gap:2px; width:100%; }
	.folder-row { display:grid; grid-template-columns:28px minmax(0,1fr) 32px; align-items:center; min-height:42px; padding-left:calc(var(--depth) * 16px); border-radius:10px; transition:background .12s ease, box-shadow .12s ease; }
	.folder-row:hover { background:color-mix(in srgb, currentColor 7%, transparent); }
	.folder-row.selected { background:color-mix(in srgb, currentColor 12%, transparent); }
	.folder-row.drag-over { background:color-mix(in srgb, currentColor 18%, transparent); box-shadow:inset 0 0 0 1px color-mix(in srgb, currentColor 28%, transparent); }
	button { border:0; background:transparent; color:inherit; min-height:40px; touch-action:manipulation; }
	.disclosure { display:grid; place-items:center; opacity:.65; }
	.disclosure:disabled { opacity:0; }
	.disclosure svg { transition:transform .15s ease; }
	.disclosure svg.rotated { transform:rotate(90deg); }
	.folder-button { display:flex; align-items:center; gap:9px; min-width:0; text-align:left; font:inherit; padding:0 6px; }
	.folder-button span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.folder-button small { margin-left:auto; opacity:.5; font-size:.72rem; font-variant-numeric:tabular-nums; }
	.menu { display:grid; place-items:center; opacity:.45; }
	.menu:hover, .folder-row:hover .menu { opacity:1; }
	@media (pointer:coarse) { .folder-row { min-height:48px; } .disclosure,.menu { min-height:44px; } }
</style>
