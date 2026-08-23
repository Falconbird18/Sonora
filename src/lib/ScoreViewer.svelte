<script lang="ts">
	import ScoreViewerPro from './ScoreViewerPro.svelte';
	import type { ScoreItem } from './types';

	let { score, onBack }: { score: ScoreItem; onBack: () => void } = $props();
</script>

<ScoreViewerPro {score} onClose={onBack} />
