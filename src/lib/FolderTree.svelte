<script lang="ts">
	import { ChevronRight, Folder, FolderOpen, MoreHorizontal } from 'lucide-svelte';
	import type { FolderTreeNode } from './folderTree';

	export let nodes: FolderTreeNode[] = [];
	export let selectedId = '';
	export let onSelect: (folder: FolderTreeNode) => void = () => {};
	export let onMenu: (folder: FolderTreeNode) => void = () => {};

	let expanded = new Set<string>();

	function toggle(id: string) {
		expanded = new Set(expanded);
		if (expanded.has(id)) expanded.delete(id);
		else expanded.add(id);
	}
</script>

<nav class="folder-tree" aria-label="Folders">
	{#each nodes as node (node.id)}
		{@const isExpanded = expanded.has(node.id)}
		{@const hasChildren = node.children.length > 0}
		<div class="folder-branch">
			<div class:selected={selectedId === node.id} class="folder-row" style={`--depth:${node.depth}`}>
				<button class="disclosure" aria-label={isExpanded ? `Collapse ${node.name}` : `Expand ${node.name}`} disabled={!hasChildren} onclick={() => toggle(node.id)}>
					<ChevronRight size={15} class:rotated={isExpanded} />
				</button>
				<button class="folder-button" aria-current={selectedId === node.id ? 'page' : undefined} onclick={() => onSelect(node)}>
					{#if isExpanded && hasChildren}<FolderOpen size={17} />{:else}<Folder size={17} />{/if}
					<span>{node.name}</span>
				</button>
				<button class="menu" aria-label={`Options for ${node.name}`} onclick={() => onMenu(node)}><MoreHorizontal size={17} /></button>
			</div>
			{#if isExpanded && hasChildren}
				<svelte:self nodes={node.children} {selectedId} {onSelect} {onMenu} />
			{/if}
		</div>
	{/each}
</nav>

<style>
	.folder-tree { display:flex; flex-direction:column; gap:2px; width:100%; }
	.folder-row { display:grid; grid-template-columns:28px minmax(0,1fr) 32px; align-items:center; min-height:42px; padding-left:calc(var(--depth) * 16px); border-radius:10px; }
	.folder-row:hover { background:color-mix(in srgb, currentColor 7%, transparent); }
	.folder-row.selected { background:color-mix(in srgb, currentColor 12%, transparent); }
	button { border:0; background:transparent; color:inherit; min-height:40px; touch-action:manipulation; }
	.disclosure { display:grid; place-items:center; opacity:.65; }
	.disclosure:disabled { opacity:0; }
	.disclosure svg { transition:transform .15s ease; }
	.disclosure svg.rotated { transform:rotate(90deg); }
	.folder-button { display:flex; align-items:center; gap:9px; min-width:0; text-align:left; font:inherit; padding:0 6px; }
	.folder-button span { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.menu { display:grid; place-items:center; opacity:.45; }
	.menu:hover, .folder-row:hover .menu { opacity:1; }
	@media (pointer:coarse) { .folder-row { min-height:48px; } .disclosure,.menu { min-height:44px; } }
</style>
