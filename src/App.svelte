<script lang="ts">
	import * as pdfjsLib from 'pdfjs-dist';
	import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
	import LibraryView from './lib/LibraryView.svelte';
	import ScoreViewer from './lib/ScoreViewer.svelte';
	import type { ScoreItem } from './lib/types';

	pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

	let scores = $state<ScoreItem[]>([]);
	let activeScore = $state<ScoreItem | null>(null);
</script>

<main
	class="app-shell h-screen w-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans overflow-hidden select-none">
	{#if activeScore}
		<div class="view-transition flex-1 min-h-0">
			<ScoreViewer score={activeScore} onBack={() => (activeScore = null)} />
		</div>
	{:else}
		<div class="view-transition flex-1 min-h-0">
			<LibraryView
				bind:scores
				onSelectScore={(score) => (activeScore = score)} />
		</div>
	{/if}
</main>

<style>
	.app-shell {
		isolation: isolate;
	}
	.view-transition {
		animation: app-enter 0.18s ease-out;
	}
	@keyframes app-enter {
		from {
			opacity: 0;
			transform: translateY(3px);
		}
		to {
			opacity: 1;
			transform: translateY(0);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.view-transition {
			animation: none;
		}
	}
</style>
