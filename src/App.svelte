<script lang="ts">
	import * as pdfjsLib from 'pdfjs-dist';
	import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';
	import LibraryView from './lib/LibraryView.svelte';
	import ScoreViewer from './lib/ScoreViewerFixed.svelte';
	import type { ScoreItem } from './lib/types';

	// Configure PDF.js once for the whole app (thumbnails + viewer).
	pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

	let activeScore = $state<ScoreItem | null>(null);
</script>

<svelte:head>
	<meta
		name="viewport"
		content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content"
	/>
	<meta name="theme-color" content="#11110f" />
</svelte:head>

<main class="app-shell">
	<!-- Keep the library mounted so scores never disappear when returning from the viewer. -->
	<div class="layer" class:hidden={!!activeScore}>
		<LibraryView onSelectScore={(score) => (activeScore = score)} />
	</div>
	{#if activeScore}
		<div class="layer viewer-layer">
			<ScoreViewer score={activeScore} onClose={() => (activeScore = null)} />
		</div>
	{/if}
</main>

<style>
	:global(html),
	:global(body),
	:global(#app) {
		margin: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
	}
	:global(html) {
		background: #11110f;
		color-scheme: dark;
	}
	:global(button),
	:global(input),
	:global(select),
	:global(textarea) {
		font: inherit;
	}
	:global(button),
	:global(label) {
		-webkit-tap-highlight-color: transparent;
	}
	:global(button) {
		touch-action: manipulation;
	}
	:global(img) {
		-webkit-user-drag: none;
	}
	:global(.app-shell *) {
		box-sizing: border-box;
	}
	.app-shell {
		isolation: isolate;
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 100dvh;
		background: #11110f;
		color: #f5f5f4;
		overflow: hidden;
		padding-top: env(safe-area-inset-top);
		padding-bottom: env(safe-area-inset-bottom);
	}
	.layer {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	.layer.hidden {
		visibility: hidden;
		pointer-events: none;
	}
	.viewer-layer {
		z-index: 10;
		animation: app-enter 0.18s ease-out;
	}
	@media (pointer: coarse) {
		:global(button) {
			min-width: 40px;
			min-height: 40px;
		}
		:global(input),
		:global(select) {
			min-height: 40px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.viewer-layer {
			animation: none;
		}
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
</style>
