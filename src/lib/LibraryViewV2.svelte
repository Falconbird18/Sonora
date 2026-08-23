<script lang="ts">
  import { onMount } from 'svelte';
  import * as pdfjsLib from 'pdfjs-dist';
  import { Folder, FolderPlus, FileText, Search, ArrowLeft, Trash2, Music, Settings, X } from 'lucide-svelte';
  import { db } from './db';
  import { getComposerPortrait } from './composerPortraits';
  import type { ScoreItem } from './types';

  let { scores = $bindable<ScoreItem[]>([]), onSelectScore }: { scores?: ScoreItem[]; onSelectScore: (score: ScoreItem) => void } = $props();
  let searchQuery = $state('');
  let isProcessing = $state(false);
  let selectedComposerFolder = $state<string | null>(null);
  let showSettings = $state(false);
  let compactLibrary = $state(false);
  let confirmDelete = $state<string | null>(null);

  onMount(async () => { scores = await db.scores.orderBy('addedAt').reverse().toArray(); });

  async function handleFolderSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.length) return;
    isProcessing = true;
    try {
      for (const file of Array.from(input.files)) {
        if (!file.name.toLowerCase().endsWith('.pdf')) continue;
        const pathParts = (file.webkitRelativePath || file.name).split('/');
        const composer = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : 'Unknown Composer';
        const title = file.name.replace(/\.pdf$/i, '');
        let thumbnailUrl: string | undefined;
        let totalPages = 1;
        try {
          const url = URL.createObjectURL(file);
          const pdfDoc = await pdfjsLib.getDocument({ url, disableAutoFetch: true, disableStream: true }).promise;
          totalPages = pdfDoc.numPages;
          const page = await pdfDoc.getPage(1);
          const viewport = page.getViewport({ scale: 0.3 });
          const canvas = document.createElement('canvas');
          canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height);
          await page.render({ canvasContext: canvas.getContext('2d')!, viewport }).promise;
          thumbnailUrl = canvas.toDataURL('image/jpeg', 0.78);
          URL.revokeObjectURL(url);
        } catch (err) { console.warn('PDF metadata warning:', file.name, err); }

        const record: ScoreItem = { id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`, title, composer, pdfBlob: file, thumbnailUrl, totalPages, addedAt: Date.now() };
        await db.scores.put(record);
        scores = [record, ...scores];
      }
    } finally { isProcessing = false; input.value = ''; }
  }

  async function deleteScore(id: string) {
    await db.scores.delete(id);
    await db.annotations.where('scoreId').equals(id).delete();
    scores = scores.filter(s => s.id !== id);
    confirmDelete = null;
  }

  const filteredScores = $derived(scores.filter(s => s.title.toLowerCase().includes(searchQuery.toLowerCase()) || s.composer.toLowerCase().includes(searchQuery.toLowerCase())));
  const composersMap = $derived.by(() => {
    const map: Record<string, ScoreItem[]> = {};
    for (const s of filteredScores) (map[s.composer || 'Unknown Composer'] ??= []).push(s);
    return map;
  });
</script>

<div class="flex-1 flex flex-col p-4 sm:p-6 max-w-7xl w-full mx-auto overflow-hidden">
  <header class="flex items-center justify-between gap-4 pb-4 border-b border-neutral-800">
    <div class="flex items-center gap-3 min-w-0">
      {#if selectedComposerFolder}
        <button onclick={() => selectedComposerFolder = null} class="p-2 bg-neutral-800 hover:bg-neutral-700 rounded-xl"><ArrowLeft size={20}/></button>
      {/if}
      <div class="min-w-0"><h1 class="text-2xl font-bold tracking-tight truncate">{selectedComposerFolder ?? 'Music Library'}</h1><p class="text-xs text-neutral-500 mt-0.5">{selectedComposerFolder ? `${composersMap[selectedComposerFolder]?.length ?? 0} scores` : `${scores.length} scores · stored locally`}</p></div>
    </div>
    <div class="flex items-center gap-2 shrink-0">
      {#if scores.length > 0}
        <label class="flex items-center justify-center gap-2 bg-neutral-900 border border-neutral-800 hover:border-neutral-700 text-neutral-200 px-3 py-2 rounded-xl cursor-pointer transition" title="Import another folder">
          <FolderPlus size={18}/><span class="hidden sm:inline">Import</span><input type="file" webkitdirectory directory multiple accept="application/pdf" onchange={handleFolderSelect} disabled={isProcessing} class="hidden"/>
        </label>
      {/if}
      <button onclick={() => showSettings = true} class="p-2.5 rounded-xl bg-neutral-900 border border-neutral-800 hover:border-neutral-700 text-neutral-400 hover:text-white" title="Settings"><Settings size={18}/></button>
    </div>
  </header>

  {#if scores.length === 0}
    <div class="flex-1 flex items-center justify-center p-6">
      <div class="max-w-lg w-full border border-neutral-800 rounded-3xl bg-neutral-900/60 p-8 text-center">
        <div class="w-16 h-16 mx-auto mb-4 rounded-2xl bg-neutral-800 flex items-center justify-center"><Music size={30} class="text-neutral-400"/></div>
        <h2 class="text-lg font-semibold mb-2">Your music library is empty</h2>
        <p class="text-sm text-neutral-500 mb-6">Import a folder of PDF scores to begin. Your scores and annotations remain stored locally in this browser.</p>
        <label class="inline-flex items-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-xl cursor-pointer font-medium transition">
          <FolderPlus size={18}/><span>{isProcessing ? 'Processing…' : 'Import Music Folder'}</span><input type="file" webkitdirectory directory multiple accept="application/pdf" onchange={handleFolderSelect} disabled={isProcessing} class="hidden"/>
        </label>
      </div>
    </div>
  {:else}
    <div class="my-4 relative"><Search size={17} class="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-500"/><input type="text" placeholder="Search scores and composers…" bind:value={searchQuery} class="w-full bg-neutral-900 border border-neutral-800 rounded-xl pl-10 pr-4 py-2.5 text-sm focus:outline-none focus:border-blue-500"/></div>
    <div class="flex-1 overflow-y-auto pr-1">
      {#if !selectedComposerFolder}
        <div class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {#each Object.entries(composersMap) as [composer, composerScores]}
            <button onclick={() => selectedComposerFolder = composer} class="flex flex-col items-center p-4 bg-neutral-900 border border-neutral-800 hover:border-blue-500/50 hover:bg-neutral-800/80 rounded-2xl transition group text-center shadow-lg">
              <div class="relative w-20 h-20 mb-3 flex items-center justify-center"><Folder size={72} class="text-neutral-800 group-hover:text-neutral-700"/><img src={getComposerPortrait(composer)} alt={composer} class="absolute inset-0 m-auto w-12 h-12 rounded-full object-cover border-2 border-neutral-700 group-hover:border-blue-500 shadow-md"/></div>
              <span class="text-sm font-semibold truncate w-full">{composer}</span><span class="text-xs text-neutral-500 mt-1">{composerScores.length} score(s)</span>
            </button>
          {/each}
        </div>
      {:else}
        <div class:grid-cols-2={!compactLibrary} class="grid sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
          {#each composersMap[selectedComposerFolder] || [] as score}
            <div class="group relative flex flex-col bg-neutral-900 border border-neutral-800 hover:border-blue-500/50 rounded-2xl overflow-hidden transition">
              <button onclick={() => onSelectScore(score)} class="w-full flex-1 flex flex-col items-center text-left">
                <div class="w-full h-44 bg-neutral-950 flex items-center justify-center overflow-hidden border-b border-neutral-800">{#if score.thumbnailUrl}<img src={score.thumbnailUrl} alt={score.title} class="w-full h-full object-cover object-top group-hover:scale-105 transition duration-300"/>{:else}<FileText size={40} class="text-neutral-600"/>{/if}</div>
                <div class="p-3 w-full"><h3 class="text-sm font-semibold truncate group-hover:text-blue-400">{score.title}</h3><p class="text-xs text-neutral-500 mt-0.5">{score.totalPages} page(s)</p></div>
              </button>
              <button onclick={() => confirmDelete = score.id} class="absolute top-2 right-2 p-1.5 bg-neutral-900/90 hover:bg-red-600 text-neutral-400 hover:text-white rounded-lg opacity-0 group-hover:opacity-100 transition" title="Delete score"><Trash2 size={14}/></button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}

  {#if isProcessing}<div class="fixed bottom-5 left-1/2 -translate-x-1/2 z-40 bg-neutral-900 border border-neutral-700 rounded-xl px-4 py-2 text-sm shadow-xl">Importing scores…</div>{/if}

  {#if showSettings}
    <div class="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm flex items-start justify-end p-4" role="presentation" onclick={(e) => e.currentTarget === e.target && (showSettings = false)}>
      <section class="w-full max-w-sm mt-12 bg-neutral-900 border border-neutral-700 rounded-2xl shadow-2xl p-5" role="dialog" aria-modal="true" aria-label="Settings">
        <div class="flex items-center justify-between mb-5"><h2 class="text-lg font-semibold">Settings</h2><button onclick={() => showSettings=false} class="p-2 rounded-lg hover:bg-neutral-800 text-neutral-400"><X size={18}/></button></div>
        <div class="space-y-4">
          <div><h3 class="text-sm font-medium">Library</h3><p class="text-xs text-neutral-500 mt-1">Scores and annotations are stored locally; clearing browser site data can remove them.</p></div>
          <label class="flex items-center justify-between gap-4 py-2"><span><span class="block text-sm">Compact score grid</span><span class="block text-xs text-neutral-500">Fit more scores on screen.</span></span><input type="checkbox" bind:checked={compactLibrary} class="w-4 h-4"/></label>
          <div class="border-t border-neutral-800 pt-4"><p class="text-xs text-neutral-500">Sonora · local sheet music viewer</p></div>
        </div>
      </section>
    </div>
  {/if}

  {#if confirmDelete}
    <div class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"><div class="w-full max-w-sm bg-neutral-900 border border-neutral-700 rounded-2xl p-5 shadow-2xl"><h2 class="font-semibold">Delete this score?</h2><p class="text-sm text-neutral-500 mt-2">The PDF and all annotations for this score will be removed from local storage.</p><div class="flex justify-end gap-2 mt-5"><button onclick={() => confirmDelete=null} class="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700 text-sm">Cancel</button><button onclick={() => deleteScore(confirmDelete!)} class="px-3 py-2 rounded-xl bg-red-600 hover:bg-red-500 text-sm">Delete</button></div></div></div>
  {/if}
</div>
