<script lang="ts">
	import LibraryView from './lib/LibraryView.svelte';
	import ScoreViewer from './lib/ScoreViewer.svelte';
	import type { ScoreItem } from './lib/types';

	let activeScore = $state<ScoreItem | null>(null);
	let crash = $state('');

	function closeScore() {
		const finish = () => {
			activeScore = null;
			crash = '';
		};
		if (typeof document !== 'undefined' && document.fullscreenElement) {
			void document.exitFullscreen().then(finish).catch(finish);
			return;
		}
		finish();
	}

	function onWindowError(event: Event) {
		const errorEvent = event instanceof ErrorEvent ? event : null;
		const error = errorEvent?.error || errorEvent?.message || event;
		console.error('Sonora error', error);
	}

	function onUnhandled(event: PromiseRejectionEvent) {
		console.error('Sonora unhandled rejection', event.reason);
		const message = event.reason instanceof Error ? event.reason.message : String(event.reason || '');
		if (activeScore && /pdf|canvas|worker/i.test(message)) {
			crash = 'The score renderer hit a snag. Returning to your library.';
			closeScore();
		}
	}
</script>

<svelte:head>
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
	<meta name="theme-color" content="#11110f" />
</svelte:head>

<svelte:window onerror={onWindowError} onunhandledrejection={onUnhandled} />

<main class="app-shell">
	<div class="layer" class:hidden={!!activeScore} inert={!!activeScore}>
		<LibraryView paused={!!activeScore} onSelectScore={(score) => (activeScore = score)} />
	</div>
	{#if activeScore}
		<div class="layer viewer-layer">
			<ScoreViewer score={activeScore} onClose={closeScore} />
		</div>
	{/if}
	{#if crash}
		<div class="crash">{crash}</div>
	{/if}
</main>

<style>
	:global(html), :global(body), :global(#app) { margin: 0; width: 100%; height: 100%; overflow: hidden; }
	:global(html) { background: #11110f; color-scheme: dark; }
	:global(button), :global(input), :global(select), :global(textarea) { font: inherit; }
	:global(button), :global(label) { -webkit-tap-highlight-color: transparent; }
	:global(button) { touch-action: manipulation; }
	:global(img) { -webkit-user-drag: none; }
	:global(.app-shell *) { box-sizing: border-box; }
	.app-shell { isolation: isolate; position: relative; width: 100%; height: 100%; min-height: 100dvh; background: #11110f; color: #f5f5f4; overflow: hidden; padding-top: env(safe-area-inset-top); padding-bottom: env(safe-area-inset-bottom); }
	.layer { position: absolute; inset: 0; width: 100%; height: 100%; }
	.layer.hidden { visibility: hidden; pointer-events: none; }
	.viewer-layer { z-index: 10; animation: app-enter .18s ease-out; background: #11110f; }
	.crash { position: absolute; z-index: 40; left: 50%; top: 18px; transform: translateX(-50%); padding: 8px 12px; border-radius: 8px; background: #3f2a12; font-size: .82rem; }
	@media(pointer:coarse) { :global(button) { min-width: 40px; min-height: 40px; } :global(input), :global(select) { min-height: 40px; } }
	@media(prefers-reduced-motion:reduce) { .viewer-layer { animation: none; } }
	@keyframes app-enter { from { opacity: 0; transform: translateY(3px); } to { opacity: 1; transform: translateY(0); } }
</style>
