<script lang="ts">
	import { Star, FolderInput, Tag, Trash2, X } from 'lucide-svelte';
	export let count = 0;
	export let onFavorite: () => void = () => {};
	export let onMove: () => void = () => {};
	export let onTag: () => void = () => {};
	export let onDelete: () => void = () => {};
	export let onClear: () => void = () => {};
</script>

<div class="selection-bar" role="toolbar" aria-label="Bulk score actions">
	<strong>{count} selected</strong>
	<div class="actions">
		<button onclick={onFavorite} title="Favorite selected"><Star size={17}/> <span>Favorite</span></button>
		<button onclick={onMove} title="Move selected"><FolderInput size={17}/> <span>Move</span></button>
		<button onclick={onTag} title="Tag selected"><Tag size={17}/> <span>Tag</span></button>
		<button class="danger" onclick={onDelete} title="Remove selected"><Trash2 size={17}/> <span>Remove</span></button>
		<button class="clear" onclick={onClear} title="Clear selection"><X size={17}/></button>
	</div>
</div>

<style>
	.selection-bar { position:sticky; top:0; z-index:8; display:flex; align-items:center; gap:18px; padding:10px 14px; border:1px solid color-mix(in srgb,currentColor 12%,transparent); border-radius:14px; background:color-mix(in srgb,#171714 92%,transparent); backdrop-filter:blur(18px); box-shadow:0 8px 28px #0004; }
	.actions { margin-left:auto; display:flex; gap:5px; }
	button { display:flex; align-items:center; gap:7px; min-height:40px; padding:0 10px; border:0; border-radius:9px; background:transparent; color:inherit; font:inherit; cursor:pointer; touch-action:manipulation; }
	button:hover { background:#ffffff10; }
	button.danger { color:#ff8f8f; }
	button.clear { padding:0 9px; }
	@media (max-width:650px) { .selection-bar { gap:8px; } .actions button span { display:none; } .actions button { min-width:42px; justify-content:center; } }
	@media (pointer:coarse) { button { min-height:46px; } }
</style>
