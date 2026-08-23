<script lang="ts">
  import { onMount } from 'svelte';
  import * as pdfjsLib from 'pdfjs-dist';
  import pdfWorker from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
  import LibraryView from './lib/LibraryView.svelte';
  import ScoreViewer from './lib/ScoreViewerModern.svelte';
  import type { ScoreItem } from './lib/types';

  let activeScore = $state<ScoreItem | null>(null);

  onMount(() => {
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
  });
</script>

<main
  class="h-screen w-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans overflow-hidden select-none"
>
  {#if activeScore}
    <ScoreViewer score={activeScore} onBack={() => (activeScore = null)} />
  {:else}
    <LibraryView onSelectScore={(score) => (activeScore = score)} />
  {/if}
</main>
