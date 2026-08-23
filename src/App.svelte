<script lang="ts">
	import * as pdfjsLib from 'pdfjs-dist';
	import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
	import LibraryView from './lib/LibraryView.svelte';
	import ScoreViewer from './lib/ScoreViewerFixed.svelte';
	import type { ScoreItem } from './lib/types';

	pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
	let activeScore = $state<ScoreItem | null>(null);
</script>

<main class="app-shell">
	{#if activeScore}
		<div class="view-transition">
			<ScoreViewer score={activeScore} onClose={() => (activeScore = null)} />
		</div>
	{:else}
		<div class="view-transition">
			<LibraryView onSelectScore={(score) => (activeScore = score)} />
		</div>
	{/if}
</main>

<style>
	:global(html), :global(body), :global(#app) { margin:0; width:100%; height:100%; overflow:hidden; }
	.app-shell { isolation:isolate; width:100%; height:100%; background:#11110f; color:#f5f5f4; overflow:hidden; }
	.view-transition { width:100%; height:100%; animation:app-enter .18s ease-out; }
	@keyframes app-enter { from { opacity:0; transform:translateY(3px); } to { opacity:1; transform:translateY(0); } }
	@media (prefers-reduced-motion:reduce) { .view-transition { animation:none; } }
</style>
