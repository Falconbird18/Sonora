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
		Settings,
		Star
	} from '@lucide/svelte';
	import SearchField from './ui/SearchField.svelte';
	import Notice from './ui/Notice.svelte';
	import ScoreCard from './ui/ScoreCard.svelte';
	import ScoreListItem from './ui/ScoreListItem.svelte';
	import TagDialog from './ui/TagDialog.svelte';
	import ComposerPortrait from './ui/ComposerPortrait.svelte';
	import IconButton from './ui/IconButton.svelte';
	import SettingsPanel from './ui/SettingsPanel.svelte';
	import { settings } from './settingsStore';
	import { db } from './db';
	import { chooseAndAddFolder, resolveScoreSource, syncAllFolders } from './folderSync';
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
	let settingsOpen = $state(false);

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
				error = e instanceof Error ? e.message : 'Could not choose the score folder';
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
				throw new Error(`“${score.title}” has no PDF source. Try refreshing the library.`);
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
		scores = scores.map((item) => (item.id === score.id ? { ...item, favorite } : item));
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
				try {
					win.print();
				} catch {}
			});
		} else {
			const frame = document.createElement('iframe');
			frame.style.display = 'none';
			frame.src = href;
			document.body.appendChild(frame);
			frame.onload = () => {
				try {
					frame.contentWindow?.print();
				} catch {}
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
				(score) => !score.thumbnailUrl || score.thumbnailVersion !== THUMBNAIL_VERSION
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
					(score) => !score.thumbnailUrl || score.thumbnailVersion !== THUMBNAIL_VERSION
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
					sort = ['recent', 'title', 'composer'].includes(value.sort) ? value.sort : 'recent';
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
		localStorage.setItem('sonora-library-settings', JSON.stringify({ view, sort }));
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
		Array.from(new Set(scores.flatMap((score) => score.tags ?? []))).sort((a, b) =>
			a.localeCompare(b)
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
						? a.composer.localeCompare(b.composer) || a.title.localeCompare(b.title)
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
			if (settingsOpen) settingsOpen = false;
		}
	}}
/>

<div class="library" class:compact={$settings.compactLibrary}>
	<header class="header">
		<div class="brand">
			<div class="brand-mark"><Music2 size={18} strokeWidth={2.1} /></div>
			<strong>Sonora</strong>
		</div>
		<SearchField bind:value={search} placeholder="Search your scores" ariaLabel="Search scores" />
		<div class="header-actions">
			<button class="folder-button" onclick={chooseFolder}>
				<FolderPlus size={17} strokeWidth={2} />
				<span>{folder ? 'Change folder' : 'Choose folder'}</span>
			</button>
			<IconButton title="Refresh library" ariaLabel="Refresh library" onclick={sync}>
				<RefreshCw size={18} class={syncing ? 'spinning' : ''} />
			</IconButton>
			<IconButton title="Settings" ariaLabel="Open settings" onclick={() => (settingsOpen = true)}>
				<Settings size={18} />
			</IconButton>
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
				>
					<Grid2X2 size={16} /><span>All scores</span><b>{scores.length}</b>
				</button>
				<button
					class:active={filter === 'recent'}
					onclick={() => {
						filter = 'recent';
						composer = null;
					}}><Clock3 size={16} /><span>Recently opened</span></button
				>
				<button
					class:active={filter === 'favorites'}
					onclick={() => {
						filter = 'favorites';
						composer = null;
					}}><Star size={16} /><span>Favorites</span></button
				>
			</nav>
			{#if folder}
				<div class="folder-summary">
					<FolderOpen size={16} />
					<div>
						<strong>{folder.name}</strong>
						<span>{scores.length} {scores.length === 1 ? 'score' : 'scores'}</span>
					</div>
				</div>
			{/if}
			{#if Object.keys(composers).length}
				<section>
					<h2>Composers</h2>
					{#each Object.entries(composers)
						.sort((a, b) => a[0].localeCompare(b[0]))
						.slice(0, 16) as [name, count]}
						{@const portrait = getComposerPortrait(name)}
						<button
							class:active={composer === name}
							onclick={() => {
								composer = name;
								filter = 'all';
							}}
						>
							<ComposerPortrait {name} src={portrait} />
							<span>{name}</span><b>{count}</b>
						</button>
					{/each}
				</section>
			{/if}
		</aside>
		<main class="main">
			<div class="toolbar">
				<div>
					<h1>{currentTitle}</h1>
					<span>{filtered.length} {filtered.length === 1 ? 'score' : 'scores'}</span>
				</div>
				<div class="toolbar-actions">
					<select class="sort-select" bind:value={sort} aria-label="Sort scores">
						<option value="recent">Recently used</option>
						<option value="title">Title</option>
						<option value="composer">Composer</option>
					</select>
					<div class="seg">
						<button
							class:active={view === 'grid'}
							onclick={() => (view = 'grid')}
							aria-label="Grid view"><Grid2X2 size={16} /></button
						>
						<button
							class:active={view === 'list'}
							onclick={() => (view = 'list')}
							aria-label="List view"><List size={16} /></button
						>
					</div>
				</div>
			</div>
			{#if !folder}
				<div class="empty">
					<div class="empty-orb" aria-hidden="true"></div>
					<h2>Choose a score folder</h2>
					<p>Point Sonora at the folder where you keep your PDF scores to get started.</p>
					<button class="folder-button" onclick={chooseFolder}>
						<FolderPlus size={17} /><span>Choose folder</span>
					</button>
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

	<SettingsPanel open={settingsOpen} onClose={() => (settingsOpen = false)} />
</div>

<style>
	.library {
		height: 100%;
		width: 100%;
		display: flex;
		flex-direction: column;
		background: var(--sonora-bg-workspace);
		color: var(--sonora-text);
		overflow: hidden;
	}
	.header {
		height: 68px;
		flex: 0 0 68px;
		display: grid;
		grid-template-columns: 200px minmax(200px, 1fr) auto;
		align-items: center;
		gap: 20px;
		padding: 0 24px;
		border-bottom: 1px solid var(--sonora-border);
		background: var(--sonora-bg-header);
		backdrop-filter: var(--sonora-blur-sm);
		-webkit-backdrop-filter: var(--sonora-blur-sm);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
		min-width: 0;
	}
	.brand strong {
		font-size: 16px;
		font-weight: 650;
		letter-spacing: var(--sonora-tracking-tight);
	}
	.brand-mark {
		width: 34px;
		height: 34px;
		display: grid;
		place-items: center;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 11px;
		background: linear-gradient(145deg, var(--sonora-accent-soft), var(--sonora-bg-elevated));
		color: var(--sonora-accent);
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.06);
	}
	.header-actions {
		display: flex;
		justify-content: flex-end;
		align-items: center;
		gap: 8px;
	}
	.folder-button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		border: 1px solid transparent;
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
		padding: 9px 14px;
		font-size: var(--sonora-text-sm);
		font-weight: 650;
		cursor: pointer;
		box-shadow: var(--sonora-accent-glow);
		transition:
			background var(--sonora-duration) var(--sonora-ease),
			transform var(--sonora-duration) var(--sonora-ease),
			box-shadow var(--sonora-duration) var(--sonora-ease);
	}
	.folder-button:hover {
		background: var(--sonora-accent-hover);
		transform: translateY(-1px);
	}
	.folder-button:active {
		transform: translateY(0);
	}
	:global(.spinning) {
		animation: spin 0.9s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
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
		padding: 16px 12px 28px;
		border-right: 1px solid var(--sonora-border);
		background: var(--sonora-bg-sidebar);
	}
	.sidebar nav {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}
	.sidebar nav button,
	.sidebar section button {
		display: flex;
		align-items: center;
		gap: 10px;
		width: 100%;
		padding: 9px 10px;
		border: 0;
		border-radius: var(--sonora-radius-md);
		background: transparent;
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-sm);
		cursor: pointer;
		transition:
			background var(--sonora-duration) var(--sonora-ease),
			color var(--sonora-duration) var(--sonora-ease);
	}
	.sidebar nav button:hover,
	.sidebar section button:hover {
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
	}
	.sidebar nav button.active,
	.sidebar section button.active {
		background: var(--sonora-accent-soft);
		color: var(--sonora-text);
	}
	.sidebar button span {
		min-width: 0;
		flex: 1;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		text-align: left;
	}
	.sidebar button b {
		color: var(--sonora-text-faint);
		font-size: 10px;
		font-weight: 500;
	}
	.folder-summary {
		display: flex;
		gap: 10px;
		align-items: center;
		margin: 20px 4px 0;
		padding: 11px 10px;
		border: 1px solid var(--sonora-border);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-bg-elevated);
		color: var(--sonora-text-muted);
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
		color: var(--sonora-text-secondary);
		font-size: 11px;
	}
	.folder-summary span {
		font-size: 10px;
		color: var(--sonora-text-faint);
	}
	.sidebar section {
		margin-top: 22px;
	}
	.sidebar h2 {
		margin: 0 0 10px 8px;
		color: var(--sonora-text-faint);
		font-size: 10px;
		font-weight: 650;
		letter-spacing: var(--sonora-tracking-wide);
		text-transform: uppercase;
	}
	.main {
		min-width: 0;
		min-height: 0;
		overflow: auto;
		padding: 26px 30px 40px;
	}
	.toolbar {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 18px;
		margin-bottom: 22px;
	}
	.toolbar h1 {
		margin: 0;
		font-size: var(--sonora-text-2xl);
		line-height: 1.1;
		letter-spacing: var(--sonora-tracking-tight);
		font-weight: 650;
	}
	.toolbar > div:first-child span {
		display: block;
		margin-top: 6px;
		color: var(--sonora-text-faint);
		font-size: var(--sonora-text-sm);
	}
	.toolbar-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.sort-select {
		height: 36px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-sm);
		padding: 0 10px;
		background: var(--sonora-bg-elevated);
		color: var(--sonora-text-secondary);
		outline: 0;
		font-size: var(--sonora-text-sm);
		transition: border-color var(--sonora-duration) var(--sonora-ease);
	}
	.sort-select:hover {
		border-color: color-mix(in srgb, var(--sonora-accent) 35%, var(--sonora-border-strong));
	}
	.sort-select:focus {
		border-color: var(--sonora-border-focus);
		box-shadow: 0 0 0 3px var(--sonora-accent-soft);
	}
	.seg {
		display: flex;
		gap: 2px;
		padding: 3px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-bg-elevated);
	}
	.seg button {
		width: 32px;
		height: 30px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: 8px;
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
		transition:
			background var(--sonora-duration) var(--sonora-ease),
			color var(--sonora-duration) var(--sonora-ease);
	}
	.seg button:hover {
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
	}
	.seg button.active {
		background: var(--sonora-bg-active);
		color: var(--sonora-text);
		box-shadow: var(--sonora-shadow-xs);
	}
	.score-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
		gap: 28px 18px;
	}
	.library.compact .score-grid {
		gap: 18px 12px;
		grid-template-columns: repeat(auto-fill, minmax(148px, 1fr));
	}
	.score-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.empty {
		position: relative;
		max-width: 420px;
		margin: 56px auto 0;
		text-align: center;
		color: var(--sonora-text-muted);
	}
	.empty-orb {
		width: 72px;
		height: 72px;
		margin: 0 auto 18px;
		border-radius: 50%;
		background: radial-gradient(circle at 30% 30%, var(--sonora-accent-soft), transparent 70%);
		border: 1px solid var(--sonora-border);
		box-shadow: var(--sonora-accent-glow);
	}
	.empty h2 {
		margin: 0 0 8px;
		color: var(--sonora-text);
		font-size: 18px;
		font-weight: 650;
		letter-spacing: var(--sonora-tracking-tight);
	}
	.empty p {
		margin: 0 0 18px;
		font-size: 13px;
		line-height: 1.45;
	}
	@media (max-width: 900px) {
		.header {
			grid-template-columns: auto minmax(0, 1fr) auto;
			gap: 12px;
			padding: 0 16px;
		}
		.sidebar {
			width: 190px;
		}
		.body {
			grid-template-columns: 190px minmax(0, 1fr);
		}
		.main {
			padding: 20px 18px 32px;
		}
		.folder-button span {
			display: none;
		}
	}
	@media (max-width: 680px) {
		.header {
			height: 60px;
			flex-basis: 60px;
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
			padding: 16px 12px 28px;
		}
		.toolbar {
			align-items: center;
			margin-bottom: 16px;
		}
		.sort-select {
			display: none;
		}
		.score-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 18px 10px;
		}
	}
</style>
