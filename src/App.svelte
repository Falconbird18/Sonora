<script lang="ts">
  import { onMount } from 'svelte';
  import * as pdfjsLib from 'pdfjs-dist';
  import pdfWorker from 'pdfjs-dist/build/pdf.worker.mjs?url';

  import LibraryView from './lib/LibraryView.svelte';
  import ScoreViewer from './lib/ScoreViewer.svelte';
  import type { ScoreItem } from './lib/types';

  let scores = $state<ScoreItem[]>([]);
  let activeScore = $state<ScoreItem | null>(null);

  onMount(() => {
    // Configure worker globally once
    pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
  });
</script>

<main class="h-screen w-screen bg-neutral-950 text-neutral-100 flex flex-col font-sans overflow-hidden select-none">
  {#if activeScore}
    <ScoreViewer
      score={activeScore}
      onBack={() => activeScore = null}
    />
  {:else}
    <LibraryView
      bind:scores={scores}
      onSelectScore={(score) => activeScore = score}
    />
  {/if}
</main>
