<script lang="ts">
	import { onMount } from 'svelte';
	import * as pdfjsLib from 'pdfjs-dist';
	import {
		Folder,
		FolderPlus,
		FileText,
		Search,
		ArrowLeft,
		Trash2,
		Music,
		Grid2X2,
		List,
		Clock3,
		BookOpen
	} from 'lucide-svelte';
	import { db } from './db';
	import { getComposerPortrait } from './composerPortraits';
	import type { ScoreItem } from './types';

	let { onSelectScore }: { onSelectScore: (score: ScoreItem) => void } =
		$props();
	let scores = $state<ScoreItem[]>([]);
	let searchQuery = $state('');
	let isProcessing = $state(false);
	let selectedComposerFolder = $state<string | null>(null);
	let viewMode = $state<'grid' | 'list'>('grid');
	let sortMode = $state<'recent' | 'title'>('recent');

	onMount(async () => {
		scores = await db.scores.orderBy('addedAt').reverse().toArray();
	});

	async function createThumbnail(file: File) {
		const buffer = await file.arrayBuffer();
		const pdfDoc = await pdfjsLib.getDocument({ data: new Uint8Array(buffer) })
			.promise;
		const totalPages = pdfDoc.numPages;
		const page = await pdfDoc.getPage(1);
		const viewport = page.getViewport({ scale: 0.55 });
		const canvas = document.createElement('canvas');
		canvas.width = Math.ceil(viewport.width);
		canvas.height = Math.ceil(viewport.height);
		const ctx = canvas.getContext('2d', { alpha: false });
		if (!ctx) return { thumbnailUrl: undefined, totalPages };
		await page.render({ canvasContext: ctx, viewport }).promise;
		return { thumbnailUrl: canvas.toDataURL('image/jpeg', 0.82), totalPages };
	}

	async function handleFolderSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		if (!input.files?.length) return;
		isProcessing = true;

		try {
			for (const file of Array.from(input.files)) {
				if (!file.name.toLowerCase().endsWith('.pdf')) continue;
				let composer = 'Unknown Composer';
				const pathParts = (file.webkitRelativePath || file.name).split('/');
				if (pathParts.length >= 2) composer = pathParts[pathParts.length - 2];

				const title = file.name.replace(/\.pdf$/i, '');
				let thumbnailUrl: string | undefined;
				let totalPages = 1;
				try {
					({ thumbnailUrl, totalPages } = await createThumbnail(file));
				} catch (err) {
					console.warn('PDF preview warning:', file.name, err);
				}

				const scoreRecord: ScoreItem = {
					id: `${file.name}-${file.lastModified}-${Math.random()}`,
					title,
					composer,
					pdfBlob: file,
					thumbnailUrl,
					totalPages,
					addedAt: Date.now()
				};
				await db.scores.put(scoreRecord);
				scores = [scoreRecord, ...scores];
			}
		} finally {
			isProcessing = false;
			input.value = '';
		}
	}

	async function deleteScore(id: string, e: MouseEvent) {
		e.stopPropagation();
		await db.scores.delete(id);
		await db.annotations.where('scoreId').equals(id).delete();
		scores = scores.filter((s) => s.id !== id);
	}

	const filteredScores = $derived(
		scores
			.filter(
				(s) => !selectedComposerFolder || s.composer === selectedComposerFolder
			)
			.filter(
				(s) =>
					s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
					s.composer.toLowerCase().includes(searchQuery.toLowerCase())
			)
			.sort((a, b) =>
				sortMode === 'title'
					? a.title.localeCompare(b.title)
					: b.addedAt - a.addedAt
			)
	);

	const composersMap = $derived.by(() => {
		const map: Record<string, ScoreItem[]> = {};
		for (const s of scores.filter(
			(s) =>
				s.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
				s.composer.toLowerCase().includes(searchQuery.toLowerCase())
		)) {
			const composer = s.composer || 'Unknown Composer';
			(map[composer] ||= []).push(s);
		}
		return map;
	});

	function formatPages(n: number) {
		return `${n} ${n === 1 ? 'page' : 'pages'}`;
	}
</script>

<div
	class="flex-1 flex flex-col p-5 sm:p-6 max-w-7xl w-full mx-auto overflow-hidden">
	<header
		class="flex flex-col lg:flex-row lg:items-center justify-between gap-4 pb-5 border-b border-neutral-800">
		<div class="flex items-center gap-3 min-w-0">
			{#if selectedComposerFolder}
				<button
					onclick={() => (selectedComposerFolder = null)}
					class="p-2.5 bg-neutral-800 hover:bg-neutral-700 rounded-xl transition shrink-0"
					title="Back to composers"><ArrowLeft size={19} /></button>
			{/if}
			<div class="min-w-0">
				<div class="flex items-center gap-2">
					<BookOpen size={19} class="text-blue-400 shrink-0" />
					<h1 class="text-2xl sm:text-3xl font-bold tracking-tight truncate">
						{selectedComposerFolder || 'Music Library'}
					</h1>
				</div>
				<p class="text-sm text-neutral-500 mt-1">
					{selectedComposerFolder
						? `${filteredScores.length} ${filteredScores.length === 1 ? 'score' : 'scores'}`
						: 'Your local sheet-music collection'}
				</p>
			</div>
		</div>

		<label
			class="flex items-center justify-center gap-2 bg-blue-600 hover:bg-blue-500 text-white px-4 py-2.5 rounded-xl cursor-pointer font-medium transition shadow-lg shadow-blue-600/20">
			<FolderPlus size={19} /><span
				>{isProcessing ? 'Importing…' : 'Import Folder'}</span>
			<input
				type="file"
				webkitdirectory
				directory
				multiple
				accept="application/pdf"
				onchange={handleFolderSelect}
				disabled={isProcessing}
				class="hidden" />
		</label>
	</header>

	<div class="flex flex-col sm:flex-row gap-3 my-5">
		<div class="relative flex-1">
			<Search
				size={18}
				class="absolute left-3.5 top-1/2 -translate-y-1/2 text-neutral-500" />
			<input
				type="text"
				placeholder="Search titles and composers…"
				bind:value={searchQuery}
				class="w-full bg-neutral-900 border border-neutral-800 rounded-xl pl-10 pr-4 py-3 text-sm focus:outline-none focus:border-blue-500 transition" />
		</div>
		{#if selectedComposerFolder}
			<select
				bind:value={sortMode}
				class="bg-neutral-900 border border-neutral-800 rounded-xl px-3 text-sm text-neutral-300 outline-none"
				><option value="recent">Recently added</option><option value="title"
					>Title</option
				></select>
			<div class="flex bg-neutral-900 border border-neutral-800 rounded-xl p-1">
				<button
					onclick={() => (viewMode = 'grid')}
					class="p-2 rounded-lg {viewMode === 'grid'
						? 'bg-neutral-800 text-white'
						: 'text-neutral-500'}"
					title="Grid"><Grid2X2 size={16} /></button
				><button
					onclick={() => (viewMode = 'list')}
					class="p-2 rounded-lg {viewMode === 'list'
						? 'bg-neutral-800 text-white'
						: 'text-neutral-500'}"
					title="List"><List size={16} /></button>
			</div>
		{/if}
	</div>

	<div class="flex-1 overflow-y-auto pr-1">
		{#if scores.length === 0}
			<div
				class="h-72 flex flex-col items-center justify-center border border-dashed border-neutral-800 rounded-2xl text-neutral-500 gap-3">
				<Music size={40} />
				<p>No scores imported yet. Import a folder to begin.</p>
			</div>
		{:else if !selectedComposerFolder}
			<div
				class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
				{#each Object.entries(composersMap).sort( ([a], [b]) => a.localeCompare(b) ) as [composer, composerScores]}
					<button
						onclick={() => (selectedComposerFolder = composer)}
						class="group relative overflow-hidden flex flex-col text-left rounded-2xl border border-neutral-800 bg-neutral-900 hover:border-blue-500/50 hover:bg-neutral-800/90 transition shadow-sm">
						<div
							class="h-28 relative overflow-hidden bg-gradient-to-br from-neutral-800 to-neutral-950">
							<img
								src={getComposerPortrait(composer)}
								alt=""
								class="absolute inset-0 w-full h-full object-cover opacity-25 blur-[1px] group-hover:opacity-35 group-hover:scale-105 transition duration-500" />
							<div
								class="absolute inset-0 bg-gradient-to-t from-neutral-900 via-neutral-900/50 to-transparent">
							</div>
							<div class="absolute left-4 bottom-3 flex items-center gap-2.5">
								<div
									class="w-11 h-11 rounded-xl overflow-hidden border border-white/10 shadow-lg bg-neutral-800">
									<img
										src={getComposerPortrait(composer)}
										alt={composer}
										class="w-full h-full object-cover" />
								</div>
								<Folder size={28} class="text-blue-300/80" />
							</div>
						</div>
						<div class="p-3.5">
							<div
								class="text-sm font-semibold text-neutral-100 truncate group-hover:text-blue-300">
								{composer}
							</div>
							<div class="text-xs text-neutral-500 mt-1">
								{composerScores.length}
								{composerScores.length === 1 ? 'score' : 'scores'}
							</div>
						</div>
					</button>
				{/each}
			</div>
		{:else if filteredScores.length === 0}
			<div class="h-56 flex items-center justify-center text-neutral-500">
				No scores match your search.
			</div>
		{:else if viewMode === 'list'}
			<div
				class="rounded-2xl border border-neutral-800 overflow-hidden divide-y divide-neutral-800 bg-neutral-900/60">
				{#each filteredScores as score}
					<div
						role="button"
						onclick={() => onSelectScore(score)}
						class="w-full flex items-center gap-4 p-3 text-left hover:bg-neutral-800/70 transition group">
						<div
							class="w-12 h-16 rounded-lg bg-neutral-950 overflow-hidden border border-neutral-800 shrink-0">
							{#if score.thumbnailUrl}<img
									src={score.thumbnailUrl}
									alt=""
									class="w-full h-full object-cover object-top" />{:else}<FileText
									class="m-3 text-neutral-600"
									size={24} />{/if}
						</div>
						<div class="min-w-0 flex-1">
							<div
								class="text-sm font-semibold text-neutral-200 truncate group-hover:text-blue-300">
								{score.title}
							</div>
							<div class="text-xs text-neutral-500 mt-1">
								{formatPages(score.totalPages)}
							</div>
						</div>
						<button
							onclick={(e) => deleteScore(score.id, e)}
							class="p-2 text-neutral-500 hover:text-red-400 opacity-0 group-hover:opacity-100"
							title="Delete"><Trash2 size={16} /></button>
					</div>
				{/each}
			</div>
		{:else}
			<div
				class="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 gap-4">
				{#each filteredScores as score}
					<div
						class="group relative flex flex-col bg-neutral-900 border border-neutral-800 hover:border-blue-500/50 rounded-2xl overflow-hidden transition shadow-sm">
						<button
							onclick={() => onSelectScore(score)}
							class="w-full flex-1 flex flex-col items-center text-left">
							<div
								class="w-full aspect-[3/4] bg-neutral-950 flex items-center justify-center overflow-hidden border-b border-neutral-800 p-2">
								{#if score.thumbnailUrl}<img
										src={score.thumbnailUrl}
										alt={score.title}
										class="w-full h-full object-contain object-top rounded-sm group-hover:scale-[1.015] transition duration-300" />{:else}<FileText
										size={40}
										class="text-neutral-600" />{/if}
							</div>
							<div class="p-3 w-full">
								<h3
									class="text-sm font-semibold text-neutral-200 truncate group-hover:text-blue-300">
									{score.title}
								</h3>
								<div
									class="flex items-center gap-1.5 text-xs text-neutral-500 mt-1">
									<Clock3 size={12} />{formatPages(score.totalPages)}
								</div>
							</div>
						</button>
						<button
							onclick={(e) => deleteScore(score.id, e)}
							class="absolute top-2 right-2 p-1.5 bg-neutral-900/90 hover:bg-red-600 text-neutral-400 hover:text-white rounded-lg opacity-0 group-hover:opacity-100 transition shadow"
							title="Delete"><Trash2 size={14} /></button>
					</div>
				{/each}
			</div>
		{/if}
	</div>
</div>
