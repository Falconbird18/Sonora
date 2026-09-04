<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Clock3,
		FolderOpen,
		FolderPlus,
		Grid2X2,
		List,
		Music2,
		RefreshCw,
		Star
	} from '@lucide/svelte';
	import SearchField from './ui/SearchField.svelte';
	import Notice from './ui/Notice.svelte';
	import ScoreCard from './ui/ScoreCard.svelte';
	import ScoreListItem from './ui/ScoreListItem.svelte';
	import TagDialog from './ui/TagDialog.svelte';
	import ComposerPortrait from './ui/ComposerPortrait.svelte';
	import IconButton from './ui/IconButton.svelte';
	import { db } from './db';
	import {
		chooseAndAddFolder,
		resolveScoreSource,
		syncAllFolders
	} from './folderSync';
	import { getComposerPortrait } from './composerPortraits';
	import { getPdfInfoFromSource } from './pdfUtils';
	import { isTauri } from './paths';
	import type { FolderSource, ScoreItem } from './types';

	const THUMBNAIL_VERSION = 2;
	let {
		onSelectScore,
		paused = false
	}: { onSelectScore: (score: ScoreItem) => void; paused?: boolean } = $props();
	let scores = $state<ScoreItem[]>([]),
		folder = $state<FolderSource | undefined>(),
		search = $state('');
	let filter = $state<'all' | 'favorites' | 'recent'>('all'),
		composer = $state<string | null>(null),
		sort = $state<'recent' | 'title' | 'composer'>('recent');
	let view = $state<'grid' | 'list'>('grid'),
		menuScoreId = $state<string | null>(null),
		metadata = $state<ScoreItem | null>(null);
	let syncing = $state(false),
		notice = $state(''),
		error = $state('');
	let openingId = $state<string | null>(null),
		timer: ReturnType<typeof setInterval> | undefined,
		backfillRunning = false;

	async function refresh() {
		const [nextScores, nextFolder] = await Promise.all([
			db.scores.orderBy('addedAt').reverse().toArray(),
			db.folders.get('library-root')
		]);
		scores = nextScores;
		folder = nextFolder;
	}
	async function sync() {
		if (syncing || paused) return;
		syncing = true;
		error = '';
		try {
			const results = await syncAllFolders();
			const result = results[0];
			notice = result
				? result.added || result.updated || result.removed
					? `${result.added + result.updated} updated · ${result.removed} removed`
					: 'Library is up to date'
				: 'Choose a score folder to begin';
			await refresh();
			void backfillThumbnails();
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not sync the library';
		} finally {
			syncing = false;
			setTimeout(() => (notice = ''), 3000);
		}
	}
	async function chooseFolder() {
		error = '';
		try {
			await chooseAndAddFolder();
			await refresh();
			void backfillThumbnails();
		} catch (e) {
			if ((e as DOMException)?.name !== 'AbortError')
				error =
					e instanceof Error ? e.message : 'Could not choose the score folder';
		}
	}
	function prepareScore(score: ScoreItem): ScoreItem {
		const source = resolveScoreSource(score, folder);
		return {
			...score,
			pdfUrl: source.url || score.pdfUrl,
			nativePath: source.nativePath || score.nativePath,
			pdfBlob: isTauri() ? undefined : source.blob || score.pdfBlob
		};
	}
	async function openScore(score: ScoreItem) {
		closeMenu();
		error = '';
		openingId = score.id;
		try {
			const prepared = prepareScore(score);
			if (
				!prepared.pdfUrl &&
				!prepared.nativePath &&
				!(prepared.pdfBlob && prepared.pdfBlob.size > 0)
			)
				throw new Error(
					`“${score.title}” has no PDF source. Try refreshing the library.`
				);
			const openedAt = Date.now();
			void db.scores
				.update(score.id, { lastOpenedAt: openedAt })
				.catch((err) => console.warn('Could not update last opened', err));
			scores = scores.map((item) =>
				item.id === score.id ? { ...item, lastOpenedAt: openedAt } : item
			);
			onSelectScore({ ...prepared, lastOpenedAt: openedAt });
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not open this score';
		} finally {
			openingId = null;
		}
	}
	async function toggleFavorite(score: ScoreItem, event: MouseEvent) {
		event.stopPropagation();
		const favorite = !score.favorite;
		await db.scores.update(score.id, { favorite });
		scores = scores.map((item) =>
			item.id === score.id ? { ...item, favorite } : item
		);
		if (favorite) closeMenu();
	}
	function toggleMenu(score: ScoreItem, event: MouseEvent) {
		event.stopPropagation();
		menuScoreId = menuScoreId === score.id ? null : score.id;
	}
	function closeMenu() {
		menuScoreId = null;
	}
	function editMetadata(score: ScoreItem, event?: MouseEvent) {
		event?.stopPropagation();
		closeMenu();
		metadata = score;
	}
	
	function downloadScoreFile(score: ScoreItem, event?: MouseEvent) {
		event?.stopPropagation();
		menuScoreId = null;
		let href = score.pdfUrl || '';
		if (!href && score.pdfBlob) href = URL.createObjectURL(score.pdfBlob);
		if (!href) {
			error = 'No PDF available to download for this score.';
			return;
		}
		const link = document.createElement('a');
		link.href = href;
		link.download = `${score.title || 'score'}.pdf`;
		link.target = '_blank';
		link.rel = 'noopener';
		link.click();
		if (score.pdfBlob && !score.pdfUrl) setTimeout(() => URL.revokeObjectURL(href), 1000);
	}

	function printScoreFile(score: ScoreItem, event?: MouseEvent) {
		event?.stopPropagation();
		menuScoreId = null;
		const href = score.pdfUrl || (score.pdfBlob ? URL.createObjectURL(score.pdfBlob) : '');
		if (!href) {
			error = 'No PDF available to print for this score.';
			return;
		}
		const win = window.open(href, '_blank', 'noopener');
		if (win) {
			win.addEventListener('load', () => {
				try { win.print(); } catch {}
			});
		} else {
			const frame = document.createElement('iframe');
			frame.style.display = 'none';
			frame.src = href;
			document.body.appendChild(frame);
			frame.onload = () => {
				try { frame.contentWindow?.print(); } catch {}
				setTimeout(() => frame.remove(), 2000);
			};
		}
		if (score.pdfBlob && !score.pdfUrl) setTimeout(() => URL.revokeObjectURL(href), 5000);
	}

	async function saveMetadata(tags: string[]) {
		if (!metadata) return;
		const next = tags.map((tag) => tag.trim()).filter(Boolean);
		try {
			await db.scores.update(metadata.id, { tags: next });
			scores = scores.map((item) =>
				item.id === metadata!.id ? { ...item, tags: next } : item
			);
			metadata = null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save tags';
		}
	}
	async function deleteScore(score: ScoreItem, event?: MouseEvent) {
		event?.stopPropagation();
		closeMenu();
		if (!confirm(`Remove “${score.title}” from Sonora?`)) return;
		try {
			await db.transaction('rw', db.scores, db.annotations, async () => {
				await db.scores.delete(score.id);
				await db.annotations.where('scoreId').equals(score.id).delete();
			});
			scores = scores.filter((item) => item.id !== score.id);
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not remove this score';
		}
	}
	async function backfillThumbnails() {
		if (backfillRunning || paused) return;
		backfillRunning = true;
		try {
			const missing = scores.filter(
				(score) =>
					!score.thumbnailUrl || score.thumbnailVersion !== THUMBNAIL_VERSION
			);
			for (const score of missing.slice(0, 4)) {
				if (paused) break;
				try {
					const source = resolveScoreSource(score, folder);
					if (!source.url && !source.blob && !source.nativePath) continue;
					const info = await getPdfInfoFromSource(source);
					if (!info.thumbnailUrl) continue;
					await db.scores.update(score.id, {
						thumbnailUrl: info.thumbnailUrl,
						thumbnailVersion: THUMBNAIL_VERSION,
						totalPages: info.totalPages || score.totalPages || 1
					});
					scores = scores.map((item) =>
						item.id === score.id
							? {
									...item,
									thumbnailUrl: info.thumbnailUrl,
									thumbnailVersion: THUMBNAIL_VERSION,
									totalPages: info.totalPages || item.totalPages || 1
								}
							: item
					);
				} catch (err) {
					console.warn('Thumbnail backfill failed', score.title, err);
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 24));
			}
			if (
				!paused &&
				scores.some(
					(score) =>
						!score.thumbnailUrl || score.thumbnailVersion !== THUMBNAIL_VERSION
				)
			)
				setTimeout(() => void backfillThumbnails(), 700);
		} finally {
			backfillRunning = false;
		}
	}
	onMount(() => {
		let disposed = false;
		const initialize = async () => {
			await refresh();
			if (disposed) return;
			const saved = localStorage.getItem('sonora-library-settings');
			if (saved) {
				try {
					const value = JSON.parse(saved);
					view = value.view === 'list' ? 'list' : 'grid';
					sort = ['recent', 'title', 'composer'].includes(value.sort)
						? value.sort
						: 'recent';
				} catch {}
			}
			if (disposed) return;
			await sync();
			if (disposed) return;
			void backfillThumbnails();
			timer = setInterval(() => void sync(), 5 * 60 * 1000);
		};
		void initialize();
		const wake = () => void sync();
		window.addEventListener('focus', wake);
		return () => {
			disposed = true;
			clearInterval(timer);
			window.removeEventListener('focus', wake);
		};
	});
	$effect(() => {
		localStorage.setItem(
			'sonora-library-settings',
			JSON.stringify({ view, sort })
		);
	});
	$effect(() => {
		if (!paused) void backfillThumbnails();
	});
	const composers = $derived.by(() => {
		const counts: Record<string, number> = {};
		for (const score of scores) {
			const name = score.composer || 'Unknown Composer';
			counts[name] = (counts[name] ?? 0) + 1;
		}
		return counts;
	});
	const allTags = $derived(
		Array.from(new Set(scores.flatMap((score) => score.tags ?? []))).sort(
			(a, b) => a.localeCompare(b)
		)
	);
	const filtered = $derived(
		scores
			.filter((score) => !composer || score.composer === composer)
			.filter(
				(score) =>
					filter === 'all' ||
					(filter === 'favorites' ? !!score.favorite : !!score.lastOpenedAt)
			)
			.filter((score) => {
				const query = search.trim().toLowerCase();
				return (
					!query ||
					score.title.toLowerCase().includes(query) ||
					score.composer.toLowerCase().includes(query) ||
					(score.tags ?? []).some((tag) => tag.toLowerCase().includes(query))
				);
			})
			.sort((a, b) =>
				sort === 'title'
					? a.title.localeCompare(b.title)
					: sort === 'composer'
						? a.composer.localeCompare(b.composer) ||
							a.title.localeCompare(b.title)
						: (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt)
			)
	);
	const currentTitle = $derived(
		composer
			? composer
			: filter === 'favorites'
				? 'Favorites'
				: filter === 'recent'
					? 'Recently opened'
					: 'All scores'
	);
</script>

<svelte:window
	onclick={() => closeMenu()}
	onkeydown={(event) => {
		if (event.key === 'Escape') {
			closeMenu();
			if (metadata) metadata = null;
		}
	}} />

<div class="library">
	<header class="header">
		<div class="brand">
			<div class="brand-mark"><Music2 size={19} /></div>
			<strong>Sonora</strong>
		</div>
		<SearchField bind:value={search} placeholder="Search your scores" ariaLabel="Search scores" />
		<div class="header-actions">
			<button class="folder-button" onclick={chooseFolder}
				><FolderPlus size={17} /><span
					>{folder ? 'Change folder' : 'Choose folder'}</span
				></button
			><IconButton
				title="Refresh library"
				ariaLabel="Refresh library"
				onclick={sync}
			><RefreshCw size={18} class={syncing ? 'spinning' : ''} /></IconButton>
		</div>
	</header>
	{#if error}
		<Notice variant="error" dismissible ondismiss={() => (error = '')}>{error}</Notice>
	{/if}
	{#if notice}
		<Notice variant="success">{notice}</Notice>
	{/if}
	<div class="body">
		<aside class="sidebar">
			<nav aria-label="Library filters">
				<button
					class:active={filter === 'all' && !composer}
					onclick={() => {
						filter = 'all';
						composer = null;
					}}
					><Grid2X2 size={16} /><span>All scores</span><b>{scores.length}</b
					></button
				><button
					class:active={filter === 'recent'}
					onclick={() => {
						filter = 'recent';
						composer = null;
					}}><Clock3 size={16} /><span>Recently opened</span></button
				><button
					class:active={filter === 'favorites'}
					onclick={() => {
						filter = 'favorites';
						composer = null;
					}}><Star size={16} /><span>Favorites</span></button>
			</nav>
			{#if folder}<div class="folder-summary">
					<FolderOpen size={16} />
					<div>
						<strong>{folder.name}</strong><span
							>{scores.length} {scores.length === 1 ? 'score' : 'scores'}</span>
					</div>
				</div>{/if}{#if Object.keys(composers).length}<section>
					<h2>Composers</h2>
					{#each Object.entries(composers)
						.sort((a, b) => a[0].localeCompare(b[0]))
						.slice(0, 16) as [name, count]}{@const portrait =
							getComposerPortrait(name)}<button
							class:active={composer === name}
							onclick={() => {
								composer = name;
								filter = 'all';
							}}
							><ComposerPortrait {name} src={portrait} />
							<span>{name}</span><b>{count}</b></button
						>{/each}
				</section>{/if}
		</aside>
		<main class="main">
			<div class="toolbar">
				<div>
					<h1>{currentTitle}</h1>
					<span
						>{filtered.length}
						{filtered.length === 1 ? 'score' : 'scores'}</span>
				</div>
				<div class="toolbar-actions">
					<select class="sort-select" bind:value={sort} aria-label="Sort scores"
						><option value="recent">Recently used</option><option value="title"
							>Title</option
						><option value="composer">Composer</option></select
					>
					<div class="seg">
						<button
							class:active={view === 'grid'}
							onclick={() => (view = 'grid')}
							aria-label="Grid view"><Grid2X2 size={16} /></button
						><button
							class:active={view === 'list'}
							onclick={() => (view = 'list')}
							aria-label="List view"><List size={16} /></button>
					</div>
				</div>
			</div>
			{#if !folder}
				<div class="empty">
					<h2>Choose a score folder</h2>
					<p>Point Sonora at the folder where you keep your PDF scores to get started.</p>
					<button class="folder-button" onclick={chooseFolder}
						><FolderPlus size={17} /><span>Choose folder</span></button>
				</div>
			{:else if !filtered.length}
				<div class="empty">
					<h2>No scores match</h2>
					<p>Try another search or filter, or refresh the library.</p>
				</div>
			{:else if view === 'list'}
				<div class="score-list">
					{#each filtered as score (score.id)}
						<ScoreListItem
							{score}
							opening={openingId === score.id}
							menuOpen={menuScoreId === score.id}
							onOpen={(s) => void openScore(s)}
							onToggleFavorite={toggleFavorite}
							onToggleMenu={toggleMenu}
							onEditTags={editMetadata}
							onDownload={downloadScoreFile}
							onPrint={printScoreFile}
							onDelete={deleteScore}
						/>
					{/each}
				</div>
			{:else}
				<div class="score-grid">
					{#each filtered as score (score.id)}
						<ScoreCard
							{score}
							opening={openingId === score.id}
							menuOpen={menuScoreId === score.id}
							onOpen={(s) => void openScore(s)}
							onToggleFavorite={toggleFavorite}
							onToggleMenu={toggleMenu}
							onEditTags={editMetadata}
							onDownload={downloadScoreFile}
							onPrint={printScoreFile}
							onDelete={deleteScore}
						/>
					{/each}
				</div>
			{/if}
		</main>
	</div>
	{#if metadata}
		<TagDialog
			title={metadata.title}
			tags={metadata.tags ?? []}
			suggestions={allTags}
			onSave={(tags) => void saveMetadata(tags)}
			onClose={() => (metadata = null)}
		/>
	{/if}
</div>

<style>
	.library {
		height: 100%;
		width: 100%;
		display: flex;
		flex-direction: column;
		background: #11110f;
		color: #f5f5f4;
		overflow: hidden;
	}
	.header {
		height: 70px;
		flex: 0 0 70px;
		display: grid;
		grid-template-columns: 220px minmax(220px, 560px) 220px;
		align-items: center;
		justify-content: space-between;
		gap: 24px;
		padding: 0 28px;
		border-bottom: 1px solid #282824;
		background: #151512;
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.brand strong {
		font-size: 17px;
		letter-spacing: -0.02em;
	}
	.brand-mark {
		width: 34px;
		height: 34px;
		display: grid;
		place-items: center;
		border: 1px solid #35352f;
		border-radius: 10px;
		background: #1d1d19;
		color: #d8d8d0;
	}
	.header-actions {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 8px;
	}
	.folder-button,
	.primary {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		border: 1px solid #3c3c35;
		border-radius: 10px;
		background: #e6e6de;
		color: #171713;
		padding: 9px 13px;
		font-size: 12px;
		font-weight: 650;
		cursor: pointer;
	}
	.folder-button:hover,
	.primary:hover {
		background: #f0f0e8;
	}
	:global(.spinning) {
		animation: spin 0.9s linear infinite;
	}
	.body {
		min-height: 0;
		flex: 1;
		display: grid;
		grid-template-columns: 220px minmax(0, 1fr);
	}
	.sidebar {
		min-height: 0;
		overflow: auto;
		padding: 18px 14px 28px;
		border-right: 1px solid #282824;
		background: #131311;
	}
	.sidebar nav {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.sidebar nav button,
	.sidebar section button {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 9px 10px;
		border: 0;
		border-radius: 10px;
		background: transparent;
		color: #8a8a82;
		font-size: 12px;
		cursor: pointer;
	}
	.sidebar nav button:hover,
	.sidebar section button:hover,
	.sidebar nav button.active,
	.sidebar section button.active {
		background: #1f1f1b;
		color: #e4e4dc;
	}
	.sidebar button span:not(.portrait span) {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sidebar button b {
		color: #5f5f58;
		font-size: 10px;
		font-weight: 500;
	}
	.folder-summary {
		display: flex;
		gap: 10px;
		align-items: center;
		margin: 22px 5px 0;
		padding: 11px 9px;
		border: 1px solid #282824;
		border-radius: 10px;
		background: #191916;
		color: #797971;
	}
	.folder-summary div {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.folder-summary strong {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: #b4b4ac;
		font-size: 11px;
	}
	.folder-summary span {
		font-size: 10px;
		color: #5f5f58;
	}
	.sidebar section {
		margin-top: 24px;
	}
	.sidebar h2 {
		margin: 0 0 10px 8px;
		color: #5f5f58;
		font-size: 10px;
		font-weight: 650;
		letter-spacing: 0.06em;
		text-transform: uppercase;
	}
	.sidebar section button {
		margin-bottom: 2px;
	}
	.main {
		min-width: 0;
		min-height: 0;
		overflow: auto;
		padding: 28px 32px 42px;
	}
	.toolbar {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 18px;
		margin-bottom: 24px;
	}
	.toolbar h1 {
		margin: 0;
		font-size: 23px;
		line-height: 1.1;
		letter-spacing: -0.03em;
		font-weight: 650;
	}
	.toolbar > div:first-child span {
		display: block;
		margin-top: 6px;
		color: #66665f;
		font-size: 11px;
	}
	.toolbar-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.sort-select {
		height: 36px;
		border: 1px solid #30302b;
		border-radius: 9px;
		padding: 0 10px;
		background: #1a1a17;
		color: #a6a69e;
		outline: 0;
		font-size: 11px;
	}
	.sort-select:focus {
		border-color: #55554d;
	}
	.seg {
		display: flex;
		gap: 2px;
		padding: 3px;
		border: 1px solid #30302b;
		border-radius: 10px;
		background: #1a1a17;
	}
	.seg button {
		width: 31px;
		height: 30px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 7px;
		background: transparent;
		color: #66665f;
		cursor: pointer;
	}
	.seg button:hover,
	.seg button.active {
		background: #292923;
		color: #ddd;
	}
	.score-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
		gap: 28px 18px;
	}
	.score-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.empty {
		max-width: 420px;
		margin: 48px auto 0;
		text-align: center;
		color: #77776f;
	}
	.empty h2 {
		margin: 0 0 8px;
		color: #d5d5cd;
		font-size: 18px;
		font-weight: 650;
	}
	.empty p {
		margin: 0 0 18px;
		font-size: 13px;
		line-height: 1.45;
	}
	animation: spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (max-width: 900px) {
		.header {
			grid-template-columns: auto minmax(0, 1fr) auto;
			gap: 12px;
			padding: 0 18px;
		}
		.sidebar {
			width: 190px;
		}
		.body {
			grid-template-columns: 190px minmax(0, 1fr);
		}
		.main {
			padding: 22px 20px 34px;
		}
		.folder-button span {
			display: none;
		}
	}
	@media (max-width: 680px) {
		.header {
			height: 62px;
			flex-basis: 62px;
			grid-template-columns: auto minmax(0, 1fr) auto;
			padding: 0 12px;
		}
		.brand strong {
			display: none;
		}
		.body {
			display: block;
		}
		.sidebar {
			display: none;
		}
		.main {
			padding: 17px 12px 30px;
		}
		.toolbar {
			align-items: center;
			margin-bottom: 18px;
		}
		.sort-select {
			display: none;
		}
		.score-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 20px 11px;
		}
	}
</style>
