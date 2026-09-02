<script lang="ts">
	import type { ScoreItem } from './lib/types';

	let activeScore = $state<ScoreItem | null>(null);
	let crash = $state('');
	let libraryView = $state<any>(null);
	let libraryError = $state('');
	let scoreViewer = $state<any>(null);
	let scoreViewerError = $state('');

	async function loadLibraryView() {
		if (libraryView || libraryError) return;
		try {
			const module = await import('./lib/LibraryViewRedesign.svelte');
			libraryView = module.default;
		} catch (reason) {
			console.error('Sonora library failed to load', reason);
			libraryError = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason);
		}
	}

	async function loadScoreViewer() {
		if (scoreViewer || scoreViewerError) return;
		try {
			const module = await import('./lib/ScoreViewer.svelte');
			scoreViewer = module.default;
		} catch (reason) {
			console.error('Sonora score viewer failed to load', reason);
			scoreViewerError = reason instanceof Error ? reason.message : String(reason);
		}
	}

	loadLibraryView();

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

	function openScore(score: ScoreItem) {
		activeScore = score;
		crash = '';
		scoreViewerError = '';
		void loadScoreViewer();
	}
</script>

<svelte:head>
	<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
	<meta name="theme-color" content="#11110f" />
</svelte:head>

<svelte:window onerror={onWindowError} onunhandledrejection={onUnhandled} />

<main class="app-shell">
	{#if libraryView}
		{@const LibraryView = libraryView}
		<div class="layer" class:hidden={!!activeScore} inert={!!activeScore}>
			<svelte:component this={LibraryView} paused={!!activeScore} onSelectScore={openScore} />
		</div>
	{:else if libraryError}
		<div class="startup-error">
			<strong>Sonora could not load the library.</strong>
			<p>{libraryError}</p>
			<button onclick={() => location.reload()}>Reload</button>
		</div>
	{:else}
		<div class="startup-loading"><span></span><strong>Starting Sonora…</strong></div>
	{/if}

	{#if activeScore}
		<div class="layer viewer-layer">
			{#if scoreViewer}
				<svelte:component this={scoreViewer} score={activeScore} onClose={closeScore} />
			{:else if scoreViewerError}
				<div class="viewer-error">
					<strong>Sonora could not load the score viewer.</strong>
					<p>{scoreViewerError}</p>
					<button onclick={closeScore}>Return to library</button>
				</div>
			{:else}
				<div class="viewer-loading"><span></span><strong>Preparing score viewer…</strong></div>
			{/if}
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
	.startup-loading, .startup-error, .viewer-loading, .viewer-error { width: min(680px, calc(100% - 48px)); margin: auto; display: grid; place-items: center; align-content: center; gap: 12px; height: 100%; text-align: center; color: #f5f5f4; }
	.startup-error p, .viewer-error p { max-width: 620px; margin: 0; color: #cfcfcb; overflow-wrap: anywhere; }
	.startup-error button, .viewer-error button { border: 1px solid #3a3a35; border-radius: 10px; padding: 9px 14px; background: #24241f; color: inherit; cursor: pointer; }
	.startup-loading span, .viewer-loading span { width: 20px; height: 20px; border: 2px solid #44443e; border-top-color: #f5f5f4; border-radius: 50%; animation: spin .75s linear infinite; }
	.viewer-layer { z-index: 10; background: #11110f; }
	.crash { position: absolute; z-index: 40; left: 50%; top: 18px; transform: translateX(-50%); padding: 8px 12px; border-radius: 8px; background: #3f2a12; font-size: .82rem; }
	@media(pointer:coarse) { :global(button) { min-width: 40px; min-height: 40px; } :global(input), :global(select) { min-height: 40px; } }
	@media(prefers-reduced-motion:reduce) { .startup-loading span, .viewer-loading span { animation: none; } }
	@keyframes spin { to { transform: rotate(360deg); } }
</style>
