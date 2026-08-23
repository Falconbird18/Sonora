<script lang="ts">
  import { onMount } from 'svelte';
  import * as pdfjsLib from 'pdfjs-dist';
  import { Folder, FolderPlus, FileText, Search, ArrowLeft, Trash2, Music } from 'lucide-svelte';
  import { db } from './db';
  import { getComposerPortrait } from './composerPortraits';
  import type { ScoreItem } from './types';

  let { onSelectScore }: { onSelectScore: (score: ScoreItem) => void } = $props();

  let scores = $state<ScoreItem[]>([]);
  let searchQuery = $state('');
  let isProcessing = $state(false);
  let selectedComposerFolder = $state<string | null>(null);

  onMount(async () => {
    scores = await db.scores.orderBy('addedAt').reverse().toArray();
  });

  async function handleFolderSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    isProcessing = true;

    for (const file of Array.from(input.files)) {
      if (!file.name.toLowerCase().endsWith('.pdf')) continue;

      let inferredComposer = 'Unknown Composer';
      const pathParts = (file.webkitRelativePath || file.name).split('/');
      if (pathParts.length >= 2) inferredComposer = pathParts[pathParts.length - 2];

      const title = file.name.replace(/\.pdf$/i, '');

      let thumbnailUrl: string | undefined;
      let totalPages = 1;

      try {
        const buffer = await file.arrayBuffer();
        const pdfDoc = await pdfjsLib.getDocument({ data: buffer }).promise;
        totalPages = pdfDoc.numPages;

        const page = await pdfDoc.getPage(1);
        const viewport = page.getViewport({ scale: 0.3 });
        const canvas = document.createElement('canvas');
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          await page.render({ canvasContext: ctx, viewport }).promise;
          thumbnailUrl = canvas.toDataURL('image/jpeg', 0.8);
        }
      } catch (err) {
        console.warn('PDF load warning:', file.name, err);
      }

      const scoreRecord: ScoreItem = {
        id: `${file.name}-${file.lastModified}-${Math.random()}`,
        title,
        composer: inferredComposer,
        pdfBlob: file,
        thumbnailUrl,
        totalPages,
        addedAt: Date.now()
      };

      await db.scores.put(scoreRecord);
      scores = [scoreRecord, ...scores];
    }

    isProcessing = false;
  }

  async function deleteScore(id: string, e: MouseEvent) {
    e.stopPropagation();
    await db.scores.delete(id);
    await db.annotations.where('scoreId').equals(id).delete();
    scores = scores.filter(s => s.id !== id);
  }

  // Filter Scores
  const filteredScores = $derived(
    scores.filter(s =>
      s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      s.composer.toLowerCase().includes(searchQuery.toLowerCase())
    )
  );

  // Group by Composer
  const composersMap = $derived.by(() => {
    const map: Record<string, ScoreItem[]> = {};
    for (const s of filteredScores) {
      const comp = s.composer || 'Unknown Composer';
      if (!map[comp]) map[comp] = [];
      map[comp].push(s);
    }
    return map;
  });
</script>

<div class="flex-1 flex flex-col p-6 max-w-7xl w-full mx-auto overflow-hidden">
  <header class="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-neutral-800">
    <div class="flex items-center gap-3">
      {#if selectedComposerFolder}
        <button onclick={() => selectedComposerFolder = null} class="p-2 bg-neutral-800 hover:bg-neutral-700 rounded-xl transition">
          <ArrowLeft size={20} />
        </button>
      {/if}
      <div>
        <h1 class="text-3xl font-bold tracking-tight">
          {selectedComposerFolder ? selectedComposerFolder : 'Music Library'}
        </h1>
        <p class="text-sm text-neutral-400 mt-0.5">
          {selectedComposerFolder ? 'Scores in this folder' : 'Organized composer folders (Persisted locally)'}
        </p>
      </div>
    </div>

    <label class="flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-xl cursor-pointer font-medium transition shadow-lg shadow-blue-600/20 self-start sm:self-auto">
      <FolderPlus size={20} />
      <span>{isProcessing ? 'Processing Scores...' : 'Import Music Folder'}</span>
      <input type="file" webkitdirectory directory multiple accept="application/pdf" onchange={handleFolderSelect} disabled={isProcessing} class="hidden" />
    </label>
  </header>

  <div class="my-6 relative">
    <Search size={18} class="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-500" />
    <input
      type="text"
      placeholder="Search library..."
      bind:value={searchQuery}
      class="w-full bg-neutral-900 border border-neutral-800 rounded-xl pl-10 pr-4 py-3 text-sm focus:outline-none focus:border-blue-500 transition"
    />
  </div>

  <div class="flex-1 overflow-y-auto pr-2">
    {#if scores.length === 0}
      <div class="h-64 flex flex-col items-center justify-center border-2 border-dashed border-neutral-800 rounded-2xl text-neutral-500 gap-3">
        <Music size={40} />
        <p>No scores imported yet. Click <b>"Import Music Folder"</b> to load your library.</p>
      </div>

    <!-- ROOT COMPOSER FOLDERS VIEW -->
    {:else if !selectedComposerFolder}
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-5">
        {#each Object.entries(composersMap) as [composer, composerScores]}
          <button
            onclick={() => selectedComposerFolder = composer}
            class="flex flex-col items-center p-4 bg-neutral-900 border border-neutral-800 hover:border-blue-500/50 hover:bg-neutral-800/80 rounded-2xl transition group text-center cursor-pointer shadow-lg">

            <!-- Composer Face Badge Inside Folder Icon -->
            <div class="relative w-20 h-20 mb-3 flex items-center justify-center">
              <Folder size={72} class="text-neutral-800 group-hover:text-neutral-700 transition" />
              <img
                src={getComposerPortrait(composer)}
                alt={composer}
                class="absolute inset-0 m-auto w-12 h-12 rounded-full object-cover border-2 border-neutral-700 group-hover:border-blue-500 shadow-md transition"
              />
            </div>

            <span class="text-sm font-semibold text-neutral-200 group-hover:text-white truncate w-full">{composer}</span>
            <span class="text-xs text-neutral-500 mt-1">{composerScores.length} score(s)</span>
          </button>
        {/each}
      </div>

    <!-- SCORES INSIDE A SELECTED COMPOSER FOLDER -->
    {:else}
      <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
        {#each composersMap[selectedComposerFolder] || [] as score}
          <div class="group relative flex flex-col bg-neutral-900 border border-neutral-800 hover:border-blue-500/50 hover:bg-neutral-800/80 rounded-2xl overflow-hidden transition cursor-pointer">
            <button onclick={() => onSelectScore(score)} class="w-full flex-1 flex flex-col items-center">
              <div class="w-full h-48 bg-neutral-950 flex items-center justify-center overflow-hidden border-b border-neutral-800">
                {#if score.thumbnailUrl}
                  <img src={score.thumbnailUrl} alt={score.title} class="w-full h-full object-cover object-top group-hover:scale-105 transition duration-300" />
                {:else}
                  <FileText size={40} class="text-neutral-600" />
                {/if}
              </div>

              <div class="p-3 w-full text-left">
                <h3 class="text-sm font-semibold text-neutral-200 truncate group-hover:text-blue-400">{score.title}</h3>
                <p class="text-xs text-neutral-500 mt-0.5">{score.totalPages} page(s)</p>
              </div>
            </button>

            <button
              onclick={(e) => deleteScore(score.id, e)}
              class="absolute top-2 right-2 p-1.5 bg-neutral-900/90 hover:bg-red-600 text-neutral-400 hover:text-white rounded-lg opacity-0 group-hover:opacity-100 transition shadow">
              <Trash2 size={14} />
            </button>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>
