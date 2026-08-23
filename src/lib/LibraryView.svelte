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
		X
	} from 'lucide-svelte';
	import * as pdfjsLib from 'pdfjs-dist';
	import { db } from './db';
	import type { ScoreItem } from './types';

	let { onSelectScore }: { onSelectScore: (score: ScoreItem) => void } =
		$props();

	let scores = $state<ScoreItem[]>([]);
	let searchQuery = $state('');
	let isProcessing = $state(false);
	let processLabel = $state('');
	let selectedComposerFolder = $state<string | null>(null);
	let viewMode = $state<'grid' | 'list'>('grid');
	let sortMode = $state<'recent' | 'title' | 'composer'>('recent');
	let filter = $state<'all' | 'favorites' | 'recent'>('all');
	let isDragging = $state(false);

	onMount(async () => {
		scores = await db.scores.orderBy('addedAt').reverse().toArray();
	});

	async function createThumbnail(file: File) {
		const data = new Uint8Array(await file.arrayBuffer());
		const doc = await pdfjsLib.getDocument({ data, isEvalSupported: false })
			.promise;
		try {
			const totalPages = doc.numPages;
			const page = await doc.getPage(1);
			const viewport = page.getViewport({ scale: 0.35 });
			const canvas = document.createElement('canvas');
			const ctx = canvas.getContext('2d')!;

			// Handle high-DPI thumbnails
			const dpr = window.devicePixelRatio || 1;
			canvas.width = Math.ceil(viewport.width * dpr);
			canvas.height = Math.ceil(viewport.height * dpr);
			ctx.scale(dpr, dpr);

			await page.render({ canvasContext: ctx, viewport }).promise;
			return {
				thumbnailUrl: canvas.toDataURL('image/jpeg', 0.75),
				totalPages
			};
		} finally {
			await doc.destroy();
		}
	}

	async function processFiles(files: File[]) {
		if (!files.length) return;
		isProcessing = true;
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
					collection: composer
				};

				// CRITICAL FIX: Unwrap proxy state before saving to IndexedDB
				await db.scores.put($state.snapshot(score));
				scores = [score, ...scores];
			}
		} finally {
			isProcessing = false;
			processLabel = '';
		}
	}

	async function handleFolderSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files || []).filter((f) =>
			f.name.toLowerCase().endsWith('.pdf')
		);
		await processFiles(files);
		input.value = '';
	}

	async function handleSingleFiles(e: Event) {
		const input = e.target as HTMLInputElement;
		const files = Array.from(input.files || []).filter((f) =>
			f.name.toLowerCase().endsWith('.pdf')
		);
		await processFiles(files);
		input.value = '';
	}

	async function handleDrop(e: DragEvent) {
		e.preventDefault();
		isDragging = false;
		const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
			f.name.toLowerCase().endsWith('.pdf')
		);
		await processFiles(files);
	}

	async function updateScore(
		score: ScoreItem,
		patch: Partial<ScoreItem>,
		e?: MouseEvent
	) {
		e?.stopPropagation();
		const next = { ...score, ...patch };
		await db.scores.put($state.snapshot(next));
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
		if (
			!confirm(
				'Remove this score from your library? Annotations will be deleted too.'
			)
		)
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
			.filter(
				(s) => !selectedComposerFolder || s.composer === selectedComposerFolder
			)
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
				if (sortMode === 'composer')
					return a.composer.localeCompare(b.composer);
				return (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt);
			})
	);

	const composersMap = $derived.by(() => {
		const map: Record<string, ScoreItem[]> = {};
		const q = searchQuery.toLowerCase().trim();
		for (const s of scores) {
			if (
				q &&
				!s.title.toLowerCase().includes(q) &&
				!s.composer.toLowerCase().includes(q)
			)
				continue;
			(map[s.composer || 'Unknown Composer'] ||= []).push(s);
		}
		return map;
	});
</script>

<div
	class="flex flex-col h-full transition-colors {isDragging
		? 'bg-violet-900/10 ring-2 ring-inset ring-violet-500/50'
		: ''}"
	ondragover={(e) => {
		e.preventDefault();
		isDragging = true;
	}}
	ondragleave={() => (isDragging = false)}
	ondrop={handleDrop}
	role="presentation">
	<header
		class="shrink-0 border-b border-neutral-800 px-4 sm:px-6 py-4 flex flex-wrap items-center gap-3 bg-neutral-950/90 backdrop-blur">
		<!-- Header identical to original -->
		<div class="flex items-center gap-2.5 min-w-0">
			<div
				class="w-9 h-9 rounded-xl bg-gradient-to-br from-violet-500 to-blue-600 flex items-center justify-center shadow-lg shadow-violet-500/20">
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
				class="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-500 pointer-events-none" />
			<input
				bind:value={searchQuery}
				placeholder="Search scores, composers…"
				class="w-full bg-neutral-900 border border-neutral-800 rounded-xl pl-9 pr-9 py-2 text-sm outline-none focus:border-violet-500/60 focus:ring-1 focus:ring-violet-500/60 transition-all placeholder-neutral-500" />
			{#if searchQuery}
				<button
					class="absolute right-2 top-1/2 -translate-y-1/2 text-neutral-400 hover:text-white p-1"
					onclick={() => (searchQuery = '')}>
					<X size={14} />
				</button>
			{/if}
		</div>

		<div class="flex items-center gap-1.5 ml-auto">
			<label
				class="px-3 py-2 bg-neutral-900 border border-neutral-800 rounded-xl text-sm font-medium hover:bg-neutral-800 cursor-pointer transition-colors whitespace-nowrap hidden sm:block">
				Import Folder
				<input
					type="file"
					webkitdirectory
					directory
					multiple
					class="hidden"
					onchange={handleFolderSelect} />
			</label>
			<label
				class="p-2 sm:px-3 sm:py-2 bg-violet-600 text-white rounded-xl text-sm font-medium hover:bg-violet-500 shadow-sm shadow-violet-600/20 cursor-pointer transition-colors flex items-center gap-1.5 whitespace-nowrap">
				<FolderPlus size={16} />
				<span class="hidden sm:inline">Add Files</span>
				<input
					type="file"
					accept=".pdf"
					multiple
					class="hidden"
					onchange={handleSingleFiles} />
			</label>
		</div>
	</header>

	{#if isProcessing}
		<div
			class="shrink-0 bg-violet-500/10 border-b border-violet-500/20 text-violet-300 text-sm py-2.5 px-6 flex items-center justify-center gap-3">
			<div
				class="w-4 h-4 border-2 border-violet-400 border-t-transparent rounded-full animate-spin">
			</div>
			{processLabel}
		</div>
	{/if}

	<div class="flex-1 overflow-auto flex">
		<nav
			class="w-48 lg:w-56 border-r border-neutral-800 p-3 hidden md:flex flex-col gap-6 shrink-0 bg-neutral-950">
			<!-- Sidebar identical to original -->
			<div class="space-y-1">
				<button
					onclick={() => (filter = 'all')}
					class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors {filter ===
					'all'
						? 'bg-neutral-800 text-white'
						: 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'}">
					<Grid2X2 size={16} /> All Scores
				</button>
				<button
					onclick={() => (filter = 'recent')}
					class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors {filter ===
					'recent'
						? 'bg-neutral-800 text-white'
						: 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'}">
					<Clock3 size={16} /> Recent
				</button>
				<button
					onclick={() => (filter = 'favorites')}
					class="w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors {filter ===
					'favorites'
						? 'bg-neutral-800 text-white'
						: 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'}">
					<Star size={16} /> Favorites
				</button>
			</div>
			<div>
				<h3
					class="text-xs font-semibold text-neutral-500 uppercase tracking-wider mb-2 px-3">
					Composers
				</h3>
				<div class="space-y-0.5 overflow-y-auto max-h-[50vh] pr-1">
					{#each Object.entries(composersMap).sort( (a, b) => a[0].localeCompare(b[0]) ) as [comp, list]}
						<button
							onclick={() => {
								selectedComposerFolder = comp;
								filter = 'all';
							}}
							class="w-full flex items-center justify-between px-3 py-1.5 rounded-lg text-sm transition-colors group {selectedComposerFolder ===
							comp
								? 'bg-violet-500/10 text-violet-300 font-medium'
								: 'text-neutral-400 hover:text-neutral-200 hover:bg-neutral-900'}">
							<span class="truncate pr-2">{comp}</span>
							<span
								class="text-xs bg-neutral-800 px-1.5 py-0.5 rounded-md group-hover:bg-neutral-700 text-neutral-400"
								>{list.length}</span>
						</button>
					{/each}
				</div>
			</div>
		</nav>

		<main class="flex-1 min-w-0 p-4 sm:p-6 lg:p-8 bg-neutral-900">
			{#if selectedComposerFolder}
				<div class="flex items-center gap-3 mb-6">
					<button
						onclick={() => (selectedComposerFolder = null)}
						class="p-2 rounded-lg bg-neutral-800 text-neutral-400 hover:text-white hover:bg-neutral-700 transition-colors">
						<ArrowLeft size={18} />
					</button>
					<h2 class="text-xl font-semibold">{selectedComposerFolder}</h2>
				</div>
			{/if}

			<div class="flex flex-wrap items-center justify-between gap-4 mb-6">
				<h2 class="text-lg font-semibold">
					{selectedComposerFolder
						? ''
						: filter === 'favorites'
							? 'Favorites'
							: filter === 'recent'
								? 'Recent Scores'
								: 'All Scores'}
				</h2>
				<div
					class="flex items-center gap-1.5 bg-neutral-950 p-1 rounded-lg border border-neutral-800">
					<button
						onclick={() => (viewMode = 'grid')}
						class="p-1.5 rounded-md text-neutral-400 transition-colors {viewMode ===
						'grid'
							? 'bg-neutral-800 text-white shadow-sm'
							: 'hover:text-neutral-200'}">
						<Grid2X2 size={16} />
					</button>
					<button
						onclick={() => (viewMode = 'list')}
						class="p-1.5 rounded-md text-neutral-400 transition-colors {viewMode ===
						'list'
							? 'bg-neutral-800 text-white shadow-sm'
							: 'hover:text-neutral-200'}">
						<List size={16} />
					</button>
				</div>
			</div>

			{#if filteredScores.length === 0}
				<div
					class="flex flex-col items-center justify-center h-[50vh] text-center border-2 border-dashed border-neutral-800 rounded-2xl mx-auto max-w-lg">
					<div
						class="w-16 h-16 bg-neutral-800 rounded-full flex items-center justify-center text-neutral-500 mb-4">
						<FileText size={24} />
					</div>
					<h3 class="text-lg font-medium text-neutral-200 mb-1">
						No scores found
					</h3>
					<p class="text-sm text-neutral-500 max-w-xs">
						Drag and drop PDF files anywhere, or click "Add Files" to start
						building your library.
					</p>
				</div>
			{:else}
				<div
					class={viewMode === 'grid'
						? 'grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5 gap-4 sm:gap-6'
						: 'flex flex-col gap-2'}>
					{#each filteredScores as score (score.id)}
						<button
							onclick={() => openScore(score)}
							class="group text-left relative {viewMode === 'grid'
								? 'flex flex-col bg-neutral-950 border border-neutral-800 rounded-xl overflow-hidden hover:border-violet-500/50 hover:shadow-xl hover:shadow-violet-900/10 transition-all hover:-translate-y-1'
								: 'flex items-center gap-4 p-3 bg-neutral-950 border border-neutral-800 rounded-xl hover:bg-neutral-900 transition-colors'}">
							<div
								class={viewMode === 'grid'
									? 'aspect-[1/1.414] bg-neutral-900 relative overflow-hidden'
									: 'w-12 h-16 shrink-0 bg-neutral-900 relative rounded-md overflow-hidden'}>
								{#if score.thumbnailUrl}
									<img
										src={score.thumbnailUrl}
										alt="Cover"
										class="w-full h-full object-cover group-hover:scale-105 transition-transform duration-500"
										loading="lazy" />
									<div
										class="absolute inset-0 bg-gradient-to-t from-black/40 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
									</div>
								{:else}
									<div
										class="absolute inset-0 flex flex-col items-center justify-center p-4">
										<div
											class="w-10 h-10 rounded-full bg-neutral-800 flex items-center justify-center text-neutral-600 mb-2">
											<Music size={18} />
										</div>
										{#if viewMode === 'grid'}<div
												class="text-[10px] uppercase font-bold tracking-widest text-neutral-600 truncate w-full text-center">
												{initials(score.composer)}
											</div>{/if}
									</div>
								{/if}
							</div>

							<div class={viewMode === 'grid' ? 'p-3' : 'flex-1 min-w-0'}>
								<div class="flex items-start justify-between gap-2">
									<h3
										class="font-medium text-sm text-neutral-200 truncate group-hover:text-violet-300 transition-colors">
										{score.title}
									</h3>
								</div>
								<p class="text-xs text-neutral-500 truncate mt-0.5">
									{score.composer}
								</p>
								{#if viewMode === 'grid'}<p
										class="text-[11px] text-neutral-600 mt-2 font-medium">
										{pages(score.totalPages)}
									</p>{/if}
							</div>

							<div
								class="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity flex flex-col gap-1.5 z-10">
								<div
									role="button"
									class="p-1.5 bg-black/60 backdrop-blur rounded-lg text-neutral-300 hover:text-yellow-400 transition-colors"
									onclick={(e) => toggleFavorite(score, e)}>
									<Star
										size={14}
										class={score.favorite
											? 'fill-yellow-400 text-yellow-400'
											: ''} />
								</div>
								<div
									role="button"
									class="p-1.5 bg-black/60 backdrop-blur rounded-lg text-neutral-300 hover:text-red-400 transition-colors"
									onclick={(e) => deleteScore(score.id, e)}>
									<Trash2 size={14} />
								</div>
							</div>
						</button>
					{/each}
				</div>
			{/if}
		</main>
	</div>
</div>
