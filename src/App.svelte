<script lang="ts">
	import LibraryView from './lib/LibraryView.svelte';
	import ScoreViewer from './lib/ScoreViewerFixed.svelte';
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

	function onWindowError(event: ErrorEvent) {
		console.error('Sonora error', event.error || event.message);
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