<script lang="ts">
  import { onMount } from 'svelte';
  import {
    FolderPlus,
    FileText,
    Search,
    ArrowLeft,
    Trash2,
    Music,
    Grid2X2,
    List,
    Clock3,
    Star,
    X,
  } from 'lucide-svelte';
  import * as pdfjsLib from 'pdfjs-dist';
  import { db } from './db';
  import type { ScoreItem } from './types';

  let { onSelectScore }: { onSelectScore: (score: ScoreItem) => void } = $props();

  let scores = $state<ScoreItem[]>([]);
  let searchQuery = $state('');
  let isProcessing = $state(false);
  let processLabel = $state('');
  let selectedComposerFolder = $state<string | null>(null);
  let viewMode = $state<'grid' | 'list'>('grid');
  let sortMode = $state<'recent' | 'title' | 'composer'>('recent');
  let filter = $state<'all' | 'favorites' | 'recent'>('all');

  onMount(async () => {
    scores = await db.scores.orderBy('addedAt').reverse().toArray();
  });

  async function createThumbnail(file: File) {
    const data = new Uint8Array(await file.arrayBuffer());
    const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false }).promise;
    try {
      const totalPages = doc.numPages;
      const page = await doc.getPage(1);
      const viewport = page.getViewport({ scale: 0.35 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      // pdf.js v6+: prefer canvas parameter (canvasContext alone is legacy)
      await page.render({ canvas, viewport }).promise;
      return {
        thumbnailUrl: canvas.toDataURL('image/jpeg', 0.75),
        totalPages,
      };
    } finally {
      await doc.destroy();
    }
  }

  async function handleFolderSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.length) return;
    isProcessing = true;
    const files = Array.from(input.files).filter((f) =>
      f.name.toLowerCase().endsWith('.pdf'),
    );
    let done = 0;
    try {
      for (const file of files) {
        done += 1;
        processLabel = `Importing ${done}/${files.length}…`;
        const parts = (file.webkitRelativePath || file.name).split('/');
        const composer =
          parts.length >= 2 ? parts[parts.length - 2] : 'Unknown Composer';
        let thumbnailUrl: string | undefined;
        let totalPages = 1;
        try {
          ({ thumbnailUrl, totalPages } = await createThumbnail(file));
        } catch (err) {
          console.warn('Thumbnail failed for', file.name, err);
        }
        const score: ScoreItem = {
          id: `${file.name}-${file.lastModified}-${crypto.randomUUID()}`,
          title: file.name.replace(/\.pdf$/i, ''),
          composer,
          pdfBlob: file,
          thumbnailUrl,
          totalPages,
          addedAt: Date.now(),
          lastOpenedAt: 0,
          favorite: false,
          tags: [],
          collection: composer,
        };
        await db.scores.put(score);
        scores = [score, ...scores];
      }
    } finally {
      isProcessing = false;
      processLabel = '';
      input.value = '';
    }
  }

  async function handleSingleFiles(e: Event) {
    const input = e.target as HTMLInputElement;
    if (!input.files?.length) return;
    await handleFolderSelect(e);
  }

  async function updateScore(
    score: ScoreItem,
    patch: Partial<ScoreItem>,
    e?: MouseEvent,
  ) {
    e?.stopPropagation();
    const next = { ...score, ...patch };
    await db.scores.put(next);
    scores = scores.map((s) => (s.id === score.id ? next : s));
  }

  async function openScore(score: ScoreItem) {
    const lastOpenedAt = Date.now();
    await updateScore(score, { lastOpenedAt });
    onSelectScore({ ...score, lastOpenedAt });
  }

  async function toggleFavorite(score: ScoreItem, e: MouseEvent) {
    await updateScore(score, { favorite: !score.favorite }, e);
  }

  async function deleteScore(id: string, e: MouseEvent) {
    e.stopPropagation();
    if (!confirm('Remove this score from your library? Annotations will be deleted too.'))
      return;
    await db.scores.delete(id);
    await db.annotations.where('scoreId').equals(id).delete();
    scores = scores.filter((s) => s.id !== id);
  }

  function pages(n: number) {
    return `${n} ${n === 1 ? 'page' : 'pages'}`;
  }

  function initials(name: string) {
    return name
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((x) => x[0])
      .join('')
      .toUpperCase();
  }

  const filteredScores = $derived(
    scores
      .filter((s) => !selectedComposerFolder || s.composer === selectedComposerFolder)
      .filter((s) => {
        if (filter === 'favorites') return !!s.favorite;
        if (filter === 'recent') return !!s.lastOpenedAt;
        return true;
      })
      .filter((s) => {
        const q = searchQuery.toLowerCase().trim();
        if (!q) return true;
        const tags = (s.tags || []).join(' ').toLowerCase();
        return (
          s.title.toLowerCase().includes(q) ||
          s.composer.toLowerCase().includes(q) ||
          tags.includes(q)
        );
      })
      .sort((a, b) => {
        if (sortMode === 'title') return a.title.localeCompare(b.title);
        if (sortMode === 'composer') return a.composer.localeCompare(b.composer);
        return (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt);
      }),
  );

  const composersMap = $derived.by(() => {
    const map: Record<string, ScoreItem[]> = {};
    const q = searchQuery.toLowerCase().trim();
    for (const s of scores) {
      if (
        q &&
        !s.title.toLowerCase().includes(q) &&
        !s.composer.toLowerCase().includes(q)
      ) {
        continue;
      }
      (map[s.composer || 'Unknown Composer'] ||= []).push(s);
    }
    return map;
  });
</script>

<div class="flex flex-col h-full">
  <header
    class="shrink-0 border-b border-neutral-800 px-4 sm:px-6 py-4 flex flex-wrap items-center gap-3 bg-neutral-950/90 backdrop-blur"
  >
    <div class="flex items-center gap-2.5 min-w-0">
      <div
        class="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center shadow-lg shadow-violet-500/20"
      >
        <Music size={18} class="text-white" />
      </div>
      <div class="min-w-0">
        <h1 class="text-lg font-semibold tracking-tight truncate">Sonora</h1>
        <p class="text-[11px] text-neutral-500 truncate">Sheet music library</p>
      </div>
    </div>

    <div class="relative flex-1 min-w-[180px] max-w-md">
      <Search
        size={15}
        class="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none"
      />
      <input
        bind:value={searchQuery}
        placeholder="Search scores, composers…"
        class="w-full bg-neutral-900 border border-neutral-800 rounded-xl pl-9 pr-9 py-2 text-sm outline-none focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/30 transition"
      />
      {#if searchQuery}
        <button
          onclick={() => (searchQuery = '')}
          class="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-neutral-500 hover:text-neutral-300"
          aria-label="Clear search"
        >
          <X size={14} />
        </button>
      {/if}
    </div>

    <div class="flex items-center gap-2 ml-auto flex-wrap">
      <label
        class="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-violet-600 hover:bg-violet-500 text-sm font-medium cursor-pointer transition shadow-lg shadow-violet-600/20"
      >
        <FolderPlus size={16} />
        <span class="hidden sm:inline">Import folder</span>
        <input
          type="file"
          class="hidden"
          multiple
          webkitdirectory
          onchange={handleFolderSelect}
        />
      </label>
      <label
        class="inline-flex items-center gap-2 px-3 py-2 rounded-xl bg-neutral-900 border border-neutral-700 hover:border-neutral-500 text-sm cursor-pointer transition"
      >
        <FileText size={16} />
        <span class="hidden sm:inline">Add PDFs</span>
        <input
          type="file"
          class="hidden"
          accept="application/pdf,.pdf"
          multiple
          onchange={handleSingleFiles}
        />
      </label>
    </div>
  </header>

  {#if isProcessing}
    <div
      class="px-4 py-2 bg-violet-600/15 border-b border-violet-500/30 text-sm text-violet-200 flex items-center gap-2"
    >
      <div
        class="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin"
      ></div>
      {processLabel || 'Importing…'}
    </div>
  {/if}

  <div class="flex flex-1 min-h-0">
    <aside
      class="hidden md:flex w-56 shrink-0 flex-col border-r border-neutral-800 bg-neutral-950/50"
    >
      <div class="px-3 py-3 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
        Composers
      </div>
      <button
        onclick={() => (selectedComposerFolder = null)}
        class="mx-2 px-3 py-2 rounded-lg text-left text-sm transition {selectedComposerFolder ===
        null
          ? 'bg-neutral-800 text-white'
          : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'}"
      >
        All scores
        <span class="float-right text-neutral-500 text-xs">{scores.length}</span>
      </button>
      <div class="flex-1 overflow-y-auto px-2 pb-3 space-y-0.5">
        {#each Object.entries(composersMap).sort(([a], [b]) => a.localeCompare(b)) as [name, list]}
          <button
            onclick={() => (selectedComposerFolder = name)}
            class="w-full px-3 py-2 rounded-lg text-left text-sm transition flex items-center gap-2 {selectedComposerFolder ===
            name
              ? 'bg-neutral-800 text-white'
              : 'text-neutral-400 hover:bg-neutral-900 hover:text-neutral-200'}"
          >
            <span
              class="w-7 h-7 rounded-lg bg-neutral-800 border border-neutral-700 flex items-center justify-center text-[10px] font-semibold text-neutral-300 shrink-0"
            >
              {initials(name)}
            </span>
            <span class="truncate flex-1">{name}</span>
            <span class="text-xs text-neutral-500">{list.length}</span>
          </button>
        {/each}
      </div>
    </aside>

    <div class="flex-1 flex flex-col min-w-0">
      <div
        class="shrink-0 px-4 sm:px-6 py-3 flex flex-wrap items-center gap-2 border-b border-neutral-800/80"
      >
        {#if selectedComposerFolder}
          <button
            onclick={() => (selectedComposerFolder = null)}
            class="inline-flex items-center gap-1.5 text-sm text-neutral-400 hover:text-white md:hidden"
          >
            <ArrowLeft size={14} /> Back
          </button>
          <h2 class="text-sm font-medium text-neutral-200 mr-2">
            {selectedComposerFolder}
          </h2>
        {/if}

        <div class="flex rounded-lg border border-neutral-800 overflow-hidden text-xs">
          {#each (['all', 'favorites', 'recent'] as const) as f}
            <button
              onclick={() => (filter = f)}
              class="px-2.5 py-1.5 capitalize transition {filter === f
                ? 'bg-neutral-800 text-white'
                : 'text-neutral-500 hover:text-neutral-300'}"
            >
              {f}
            </button>
          {/each}
        </div>

        <select
          bind:value={sortMode}
          class="bg-neutral-900 border border-neutral-800 rounded-lg px-2 py-1.5 text-xs text-neutral-300 outline-none"
        >
          <option value="recent">Recently opened</option>
          <option value="title">Title</option>
          <option value="composer">Composer</option>
        </select>

        <div class="ml-auto flex rounded-lg border border-neutral-800 overflow-hidden">
          <button
            onclick={() => (viewMode = 'grid')}
            class="p-1.5 {viewMode === 'grid'
              ? 'bg-neutral-800 text-white'
              : 'text-neutral-500 hover:text-neutral-300'}"
            aria-label="Grid view"
          >
            <Grid2X2 size={15} />
          </button>
          <button
            onclick={() => (viewMode = 'list')}
            class="p-1.5 {viewMode === 'list'
              ? 'bg-neutral-800 text-white'
              : 'text-neutral-500 hover:text-neutral-300'}"
            aria-label="List view"
          >
            <List size={15} />
          </button>
        </div>
      </div>

      <div class="flex-1 overflow-y-auto p-4 sm:p-6">
        {#if filteredScores.length === 0}
          <div
            class="h-full min-h-[280px] flex flex-col items-center justify-center text-center px-6"
          >
            <div
              class="w-16 h-16 rounded-2xl bg-neutral-900 border border-neutral-800 flex items-center justify-center mb-4"
            >
              <Music size={28} class="text-neutral-600" />
            </div>
            <h3 class="text-base font-medium text-neutral-300 mb-1">
              {scores.length === 0 ? 'Your library is empty' : 'No matching scores'}
            </h3>
            <p class="text-sm text-neutral-500 max-w-sm mb-5">
              {scores.length === 0
                ? 'Import a folder of PDFs (organized by composer) or add individual scores to get started.'
                : 'Try a different search or filter.'}
            </p>
            {#if scores.length === 0}
              <label
                class="inline-flex items-center gap-2 px-4 py-2.5 rounded-xl bg-violet-600 hover:bg-violet-500 text-sm font-medium cursor-pointer transition"
              >
                <FolderPlus size={16} />
                Import folder
                <input
                  type="file"
                  class="hidden"
                  multiple
                  webkitdirectory
                  onchange={handleFolderSelect}
                />
              </label>
            {/if}
          </div>
        {:else if viewMode === 'list'}
          <div class="rounded-2xl border border-neutral-800 overflow-hidden divide-y divide-neutral-800/80">
            {#each filteredScores as score (score.id)}
              <div
                role="button"
                tabindex="0"
                onclick={() => openScore(score)}
                onkeydown={(e) => e.key === 'Enter' && openScore(score)}
                class="flex items-center gap-4 p-3.5 text-left hover:bg-neutral-800/60 transition group cursor-pointer"
              >
                <div
                  class="w-12 h-16 rounded-lg bg-neutral-950 overflow-hidden border border-neutral-800 shrink-0 flex items-center justify-center"
                >
                  {#if score.thumbnailUrl}
                    <img
                      src={score.thumbnailUrl}
                      alt=""
                      class="w-full h-full object-cover object-top"
                    />
                  {:else}
                    <FileText size={22} class="text-neutral-600" />
                  {/if}
                </div>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium text-neutral-100 truncate">
                    {score.title}
                  </div>
                  <div class="text-xs text-neutral-500 mt-0.5 truncate">
                    {score.composer}
                  </div>
                  <div class="flex items-center gap-3 text-xs text-neutral-500 mt-1">
                    <span>{pages(score.totalPages)}</span>
                    {#if score.lastOpenedAt}
                      <span class="inline-flex items-center gap-1">
                        <Clock3 size={11} /> Opened
                      </span>
                    {/if}
                  </div>
                </div>
                <button
                  onclick={(e) => toggleFavorite(score, e)}
                  class="p-2 text-neutral-500 hover:text-yellow-400"
                  aria-label="Favorite"
                >
                  <Star
                    size={16}
                    fill={score.favorite ? 'currentColor' : 'none'}
                    class={score.favorite ? 'text-yellow-400' : ''}
                  />
                </button>
                <button
                  onclick={(e) => deleteScore(score.id, e)}
                  class="p-2 text-neutral-500 hover:text-red-400"
                  aria-label="Delete"
                >
                  <Trash2 size={16} />
                </button>
              </div>
            {/each}
          </div>
        {:else}
          <div
            class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4"
          >
            {#each filteredScores as score (score.id)}
              <div
                class="group relative rounded-2xl bg-neutral-900 border border-neutral-800 hover:border-neutral-600 overflow-hidden transition shadow-sm hover:shadow-xl hover:shadow-black/40"
              >
                <button onclick={() => openScore(score)} class="w-full text-left">
                  <div
                    class="aspect-[3/4] bg-neutral-950 p-2.5 flex items-center justify-center border-b border-neutral-800"
                  >
                    {#if score.thumbnailUrl}
                      <img
                        src={score.thumbnailUrl}
                        alt=""
                        class="max-w-full max-h-full object-contain shadow-lg rounded-sm"
                      />
                    {:else}
                      <FileText size={32} class="text-neutral-700" />
                    {/if}
                  </div>
                  <div class="p-3.5">
                    <h3 class="text-sm font-medium text-neutral-100 truncate">
                      {score.title}
                    </h3>
                    <p class="text-xs text-neutral-500 mt-0.5 truncate">
                      {score.composer}
                    </p>
                    <div class="text-[11px] text-neutral-600 mt-1">
                      {pages(score.totalPages)}
                    </div>
                  </div>
                </button>
                <div
                  class="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition"
                >
                  <button
                    onclick={(e) => toggleFavorite(score, e)}
                    class="p-2 rounded-lg bg-neutral-900/95 border border-neutral-700 text-neutral-400 hover:text-yellow-400"
                    aria-label="Favorite"
                  >
                    <Star
                      size={14}
                      fill={score.favorite ? 'currentColor' : 'none'}
                      class={score.favorite ? 'text-yellow-400' : ''}
                    />
                  </button>
                  <button
                    onclick={(e) => deleteScore(score.id, e)}
                    class="p-2 rounded-lg bg-neutral-900/95 border border-neutral-700 text-neutral-400 hover:text-red-400"
                    aria-label="Delete"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                {#if score.favorite}
                  <div class="absolute top-2 left-2">
                    <Star size={14} class="text-yellow-400" fill="currentColor" />
                  </div>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
      </div>
    </div>
  </div>
</div>
