<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Clock3,
		Plus,
		ListMusic,
		Share2,
		FolderOpen,
		FolderPlus,
		Globe,
		Grid2X2,
		List,
		Music2,
		RefreshCw,
		Settings,
		Star
	} from '@lucide/svelte';
	import SearchField from './ui/SearchField.svelte';
	import Notice from './ui/Notice.svelte';
	import ListEditor from './ui/ListEditor.svelte';
	import AppSelect from './ui/AppSelect.svelte';
	import { createList } from './lists';
	import WorkCard from './ui/WorkCard.svelte';
	import { groupWorks, repairMetadata } from './works';
	import { formatComposer } from './composerDisplay';
	import ScoreCard from './ui/ScoreCard.svelte';
	import ScoreListItem from './ui/ScoreListItem.svelte';
	import MetadataDialog from './ui/MetadataDialog.svelte';
	import ScoreImportDialog from './ui/ScoreImportDialog.svelte';
	let importOpen = $state(false);
	import ComposerPortrait from './ui/ComposerPortrait.svelte';
	import IconButton from './ui/IconButton.svelte';
	import SettingsPanel from './ui/SettingsPanel.svelte';
	import ImslpSearchPanel from './ui/ImslpSearchPanel.svelte';
	import { maybeOrganizeScoreFile, saveScoreMetadata } from './scoreMeta';
	import { settings } from './settingsStore';
	import { db } from './db';
	import {
		chooseAndAddFolder,
		resolveScoreSource,
		syncAllFolders
	} from './folderSync';
	import {
		checkForUpdate,
		shouldShowUpdateBanner,
		dismissUpdate,
		type UpdateInfo
	} from './updateChecker';
	import { refreshComposersFromRemote } from './composerDatabase';
	import {
		getComposerPortrait,
		hydratePortraitCache
	} from './composerPortraits';
	import { getPdfInfoFromSource } from './pdfUtils';
	import { isTauri } from './paths';
	import type {
		FolderSource,
		ScoreItem,
		ScoreMetadataUpdate,
		ScoreList
	} from './types';

	const THUMBNAIL_VERSION = 2;
	let {
		onSelectScore,
		paused = false
	}: {
		onSelectScore: (
			score: ScoreItem,
			context?: { listId: string; entryId: string }
		) => void;
		paused?: boolean;
	} = $props();
	let scores = $state<ScoreItem[]>([]),
		folder = $state<FolderSource | undefined>(),
		search = $state('');
	let filter = $state<'all' | 'favorites' | 'recent'>('all'),
		composer = $state<string | null>(null),
		sort = $state<'recent' | 'title' | 'composer'>('recent');
	let view = $state<'grid' | 'list'>('grid'),
		menuScoreId = $state<string | null>(null),
		metadata = $state<ScoreItem | null>(null);
	let syncPending = false;
	let syncing = $state(false),
		notice = $state(''),
		error = $state('');
	let openingId = $state<string | null>(null),
		timer: ReturnType<typeof setInterval> | undefined,
		backfillRunning = false;
	let settingsOpen = $state(false);
	let settingsSection = $state<'sharing' | null>(null);
	let imslpOpen = $state(false);
	let selectedWorkId = $state<string | null>(null);
	let lists = $state<ScoreList[]>([]);
	let selectedListId = $state<string | null>(null);
	const selectedList = $derived(
		lists.find((list) => list.id === selectedListId)
	);
	async function newList() {
		try {
			const list = await createList('Untitled program');
			await refresh();
			selectedListId = list.id;
			selectedWorkId = null;
		} catch (e) {
			error = String(e);
		}
	}

	let organizing = $state(false);
	let organizationStatus = $state('');
	async function organizeExistingFiles() {
		if (organizing || syncing) return;
		organizing = true;
		organizationStatus = 'Organizing…';
		let moved = 0;
		try {
			for (const score of scores) {
				await maybeOrganizeScoreFile(score, score, true);
				moved++;
			}
			organizationStatus = `Organized ${moved} scores. Annotations and metadata preserved.`;
		} catch (e) {
			organizationStatus = `${moved} scores organized. ${String(e)}`;
		} finally {
			await refresh();
			organizing = false;
		}
	}

	let updateInfo = $state<UpdateInfo | null>(null);
	let updateBannerVisible = $state(false);

	async function refresh() {
		const [nextScores, nextFolder] = await Promise.all([
			db.scores.orderBy('addedAt').reverse().toArray(),
			db.folders.get('library-root')
		]);
		for (const score of nextScores) {
			const patch = repairMetadata(score, nextScores);
			if (Object.keys(patch).length) {
				await db.scores.update(score.id, patch);
				Object.assign(score, patch);
			}
		}
		lists = await db.lists.orderBy('updatedAt').reverse().toArray();
		scores = nextScores;
		folder = nextFolder;
	}
	async function sync() {
		if (paused || organizing) return;
		if (syncing) {
			syncPending = true;
			return;
		}
		syncing = true;
		error = '';
		try {
			const results = await syncAllFolders(true);
			const result = results[0];
			notice = result
				? 'skipped' in result && result.skipped
					? 'Library is up to date'
					: result.added || result.updated || result.removed
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
			if (syncPending) {
				syncPending = false;
				void sync();
			}
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
			pdfBlob: source.blob || score.pdfBlob
		};
	}
	async function openScore(
		score: ScoreItem,
		context?: { listId: string; entryId: string }
	) {
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
			onSelectScore({ ...prepared, lastOpenedAt: openedAt }, context);
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
		if (score.pdfBlob && !score.pdfUrl)
			setTimeout(() => URL.revokeObjectURL(href), 1000);
	}

	function printScoreFile(score: ScoreItem, event?: MouseEvent) {
		event?.stopPropagation();
		menuScoreId = null;
		const href =
			score.pdfUrl || (score.pdfBlob ? URL.createObjectURL(score.pdfBlob) : '');
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
		if (score.pdfBlob && !score.pdfUrl)
			setTimeout(() => URL.revokeObjectURL(href), 5000);
	}

	async function saveMetadata(payload: ScoreMetadataUpdate) {
		if (!metadata) return;
		const id = metadata.id;
		try {
			const next = await saveScoreMetadata(id, payload);
			scores = scores.map((item) =>
				item.id === id ? { ...item, ...next } : item
			);
			metadata = null;
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not save metadata';
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
			// Hydrate any previously cached portraits so UI paints immediately offline.
			void hydratePortraitCache();
			void refreshComposersFromRemote().then((result) => {
				if (result.updated) {
					console.info(
						`Composer list updated from ${result.source} (${result.count} entries)`
					);
				}
			});
			void checkForUpdate().then((info) => {
				updateInfo = info;
				updateBannerVisible = shouldShowUpdateBanner(info);
			});
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
			// Library folder sync every 5 min; composer list/portraits every hour.
			timer = setInterval(
				() => {
					void sync();
					void refreshComposersFromRemote();
				},
				5 * 60 * 1000
			);
		};
		void initialize();
		const wake = () => {
			void sync();
			void refreshComposersFromRemote();
		};
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
		for (const work of groupWorks(scores)) {
			const name = work.composer || 'Unknown Composer';
			counts[name] = (counts[name] ?? 0) + 1;
		}
		return counts;
	});
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
					[
						score.workTitle,
						score.edition,
						score.catalogue,
						score.key,
						score.instruments,
						score.publisher,
						score.editor
					].some((value) => value?.toLowerCase().includes(query)) ||
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
	const works = $derived.by(() => {
		const all = new Map(groupWorks(scores).map((work) => [work.id, work]));
		return groupWorks(filtered).map((work) => all.get(work.id) ?? work);
	});
	$effect(() => {
		search;
		selectedListId = null;
		selectedWorkId = null;
	});
	const selectedWork = $derived(
		groupWorks(scores).find((work) => work.id === selectedWorkId)
	);
	const editions = $derived(selectedWork?.scores ?? []);
	const currentTitle = $derived(
		selectedList
			? selectedList.name
			: selectedWork
				? selectedWork.title
				: composer
					? formatComposer(composer, $settings.composerDisplay)
					: filter === 'favorites'
						? 'Favorites'
						: filter === 'recent'
							? 'Recently opened'
							: 'All works'
	);
</script>

<svelte:window
	onclick={() => closeMenu()}
	onkeydown={(event) => {
		if (event.key === 'Escape') {
			closeMenu();
			if (metadata) metadata = null;
			if (imslpOpen) imslpOpen = false;
			else if (selectedWorkId) selectedWorkId = null;
			else if (settingsOpen) settingsOpen = false;
		}
	}} />

<div class="library" class:compact={$settings.compactLibrary}>
	<header class="header">
		<div class="brand">
			<span class="brand-mark" aria-hidden="true"><Music2 size={24} /></span>
			<strong>Sonora</strong>
		</div>
		<SearchField
			bind:value={search}
			placeholder="Search your scores"
			ariaLabel="Search scores" />
		<div class="header-actions">
			<button class="folder-button" onclick={() => (importOpen = true)}>
				<FolderPlus size={17} strokeWidth={2} />
				<span>Import scores</span>
			</button>
			<IconButton
				title="Refresh library"
				ariaLabel="Refresh library"
				onclick={sync}>
				<RefreshCw size={18} class={syncing ? 'spinning' : ''} />
			</IconButton>
			<IconButton
				title="Search IMSLP"
				ariaLabel="Search IMSLP for scores"
				onclick={() => (imslpOpen = true)}>
				<Globe size={18} />
			</IconButton>
			<IconButton
				title="Share library"
				ariaLabel="Share or import library"
				onclick={() => {
					settingsSection = 'sharing';
					settingsOpen = true;
				}}><Share2 size={18} /></IconButton>
			<IconButton
				title="Settings"
				ariaLabel="Open settings"
				onclick={() => {
					settingsSection = null;
					settingsOpen = true;
				}}>
				<Settings size={18} />
			</IconButton>
		</div>
	</header>

	{#if error}
		<Notice variant="error" dismissible ondismiss={() => (error = '')}
			>{error}</Notice>
	{/if}
	{#if notice}
		<Notice variant="success">{notice}</Notice>
	{/if}

	{#if updateBannerVisible && updateInfo}
		<Notice
			variant="info"
			dismissible
			ondismiss={() => {
				if (updateInfo?.tagName) dismissUpdate(updateInfo.tagName);
				updateBannerVisible = false;
			}}>
			<span>
				Sonora {updateInfo.latestVersion} is available (you have {updateInfo.currentVersion}).
				<a
					href={updateInfo.htmlUrl ||
						'https://github.com/Falconbird18/Sonora/releases'}
					target="_blank"
					rel="noopener noreferrer"
					style="color: var(--sonora-accent); font-weight: 600;">
					View release
				</a>
			</span>
		</Notice>
	{/if}

	<div class="body">
		<aside class="sidebar">
			<nav aria-label="Library filters">
				<button
					class:active={!selectedList && filter === 'all' && !composer}
					onclick={() => {
						selectedWorkId = null;
						selectedListId = null;
						filter = 'all';
						composer = null;
					}}>
					<Grid2X2 size={16} /><span>All works</span><b
						>{groupWorks(scores).length}</b>
				</button>
				<button
					class:active={!selectedList && filter === 'recent'}
					onclick={() => {
						selectedWorkId = null;
						selectedListId = null;
						filter = 'recent';
						composer = null;
					}}><Clock3 size={16} /><span>Recently opened</span></button>
				<button
					class:active={!selectedList && filter === 'favorites'}
					onclick={() => {
						selectedWorkId = null;
						selectedListId = null;
						filter = 'favorites';
						composer = null;
					}}><Star size={16} /><span>Favorites</span></button>
			</nav>
			<section class="list-section">
				<div class="list-heading">
					<h2>Lists</h2>
					<IconButton
						title="Create list"
						ariaLabel="Create list"
						size="sm"
						onclick={() => void newList()}><Plus size={16} /></IconButton>
				</div>
				{#each lists as list (list.id)}<button
						class:active={selectedListId === list.id}
						onclick={() => {
							selectedListId = list.id;
							selectedWorkId = null;
						}}
						><ListMusic size={16} /><span>{list.name}</span><b
							>{list.entries.length}</b
						></button
					>{/each}
				{#if !lists.length}<button onclick={() => void newList()}
						><Plus size={16} /><span>Create your first list</span></button
					>{/if}
			</section>

			{#if folder}
				<div class="folder-summary">
					<FolderOpen size={16} />
					<div>
						<strong>{folder.name}</strong>
						<span
							>{scores.length} {scores.length === 1 ? 'score' : 'scores'}</span>
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
							class:active={!selectedList && composer === name}
							onclick={() => {
								selectedWorkId = null;
								selectedListId = null;
								composer = name;
								filter = 'all';
							}}>
							<ComposerPortrait {name} src={portrait} />
							<span>{formatComposer(name, $settings.composerDisplay)}</span><b
								>{count}</b>
						</button>
					{/each}
				</section>
			{/if}
		</aside>
		<main class="main">
			<div class="toolbar">
				<div>
					{#if selectedWork}<button
							class="work-back"
							onclick={() => (selectedWorkId = null)}>← All works</button
						>{/if}
					<h1>{currentTitle}</h1>
					<span
						>{selectedList
							? selectedList.entries.length
							: selectedWork
								? editions.length
								: works.length}
						{selectedList
							? 'scores in performance order'
							: selectedWork
								? 'editions & parts'
								: works.length === 1
									? 'work'
									: 'works'}</span>
				</div>
				<div class="toolbar-actions">
					{#if !selectedList}<AppSelect
							bind:value={sort}
							label="Sort scores"
							options={[
								{ value: 'recent', label: 'Recently used' },
								{ value: 'title', label: 'Title' },
								{ value: 'composer', label: 'Composer' }
							]} />{/if}
					<div class="seg">
						<button
							class:active={view === 'grid'}
							onclick={() => (view = 'grid')}
							aria-label="Grid view"><Grid2X2 size={16} /></button>
						<button
							class:active={view === 'list'}
							onclick={() => (view = 'list')}
							aria-label="List view"><List size={16} /></button>
					</div>
				</div>
			</div>
			{#if selectedList}
				<ListEditor
					list={selectedList}
					{scores}
					onChanged={refresh}
					onDeleted={() => (selectedListId = null)}
					onOpen={(score, entryId) =>
						void openScore(score, { listId: selectedList.id, entryId })} />
			{:else if !scores.length}
				<div class="empty">
					<div class="empty-orb" aria-hidden="true"></div>
					<h2>Bring your scores together</h2>
					<p>
						Import individual PDFs, a batch of scores, or connect a synced
						folder.
					</p>
					<button class="folder-button" onclick={() => (importOpen = true)}>
						<FolderPlus size={17} /><span>Import scores</span>
					</button>
				</div>
			{:else if !filtered.length}
				<div class="empty">
					<h2>No scores match</h2>
					<p>Try another search or filter, or refresh the library.</p>
				</div>
			{:else if !selectedWork}
				<div
					class:score-grid={view === 'grid'}
					class:score-list={view === 'list'}>
					{#each works as work (work.id)}<WorkCard
							{work}
							list={view === 'list'}
							onOpen={() => (selectedWorkId = work.id)} />{/each}
				</div>
			{:else if view === 'list'}
				<div class="score-list">
					{#each editions as score (score.id)}
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
							onDelete={deleteScore} />
					{/each}
				</div>
			{:else}
				<div class="score-grid">
					{#each editions as score (score.id)}
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
							onDelete={deleteScore} />
					{/each}
				</div>
			{/if}
		</main>
	</div>

	{#if metadata}
		<MetadataDialog
			workTitle={metadata.workTitle}
			edition={metadata.edition}
			publisher={metadata.publisher}
			editor={metadata.editor}
			arranger={metadata.arranger}
			catalogue={metadata.catalogue}
			key={metadata.key}
			compositionDate={metadata.compositionDate}
			movements={metadata.movements}
			title={metadata.title}
			composer={metadata.composer}
			year={metadata.year}
			ensemble={metadata.ensemble}
			instruments={metadata.instruments}
			tags={metadata.tags ?? []}
			onSave={(payload) => void saveMetadata(payload)}
			onClose={() => (metadata = null)} />
	{/if}

	<SettingsPanel
		focusSection={settingsSection}
		libraryRoot={folder?.nativePath ?? null}
		onImported={refresh}
		onOrganize={folder?.nativePath ? organizeExistingFiles : undefined}
		{organizing}
		{organizationStatus}
		scoreCount={scores.length}
		open={settingsOpen}
		onClose={() => (settingsOpen = false)} />

	<ImslpSearchPanel
		bind:open={imslpOpen}
		libraryRoot={folder?.nativePath ?? null}
		onDownloaded={() => {
			void sync();
			notice = 'IMSLP score added — library refreshed';
			setTimeout(() => (notice = ''), 3000);
		}} />
</div>

{#if importOpen}<ScoreImportDialog
		onClose={() => (importOpen = false)}
		onImported={refresh}
		onChooseFolder={chooseFolder} />{/if}

<style>
	.list-heading {
		display: flex;
		justify-content: space-between;
		align-items: center;
	}
	.sidebar .list-heading h2 {
		margin: 0;
	}
	.sidebar .list-section {
		margin-top: 20px;
		padding-top: 14px;
		border-top: 1px solid var(--sonora-border);
	}
	span.brand-mark {
		display: grid;
		place-items: center;
		background: var(--sonora-accent-soft);
		color: var(--sonora-accent);
		border: 1px solid var(--sonora-border-focus);
		border-radius: var(--sonora-radius-md);
	}
	.work-back {
		background: transparent;
		border: 0;
		color: var(--sonora-accent);
		padding: 4px 0;
		margin-bottom: 8px;
		cursor: pointer;
	}
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
		gap: 16px;
		padding: 0 20px;
		border-bottom: 1px solid var(--sonora-border);
		background: color-mix(in srgb, var(--sonora-bg-elevated) 92%, transparent);
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
	}
	.brand {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.brand-mark {
		width: 34px;
		height: 34px;
		display: grid;
		place-items: center;
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-accent-soft);
		color: var(--sonora-accent);
	}
	.brand strong {
		font-size: 16px;
		font-weight: 700;
		letter-spacing: var(--sonora-tracking-tight);
	}
	.header-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.folder-button {
		height: 36px;
		display: inline-flex;
		align-items: center;
		gap: 8px;
		padding: 0 12px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-surface-raised);
		color: var(--sonora-text);
		font-size: var(--sonora-text-md);
		font-weight: 550;
		cursor: pointer;
		transition:
			background var(--sonora-duration) var(--sonora-ease),
			border-color var(--sonora-duration) var(--sonora-ease);
	}
	.folder-button:hover {
		background: var(--sonora-bg-hover);
		border-color: color-mix(
			in srgb,
			var(--sonora-accent) 35%,
			var(--sonora-border-strong)
		);
	}
	.body {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 240px minmax(0, 1fr);
	}
	.sidebar {
		width: 240px;
		overflow-y: auto;
		padding: 16px 12px 24px;
		border-right: 1px solid var(--sonora-border);
		background: color-mix(in srgb, var(--sonora-bg-elevated) 55%, transparent);
	}
	.sidebar nav {
		display: flex;
		flex-direction: column;
		gap: 2px;
		margin-bottom: 18px;
	}
	.sidebar nav button,
	.sidebar section button {
		width: 100%;
		display: flex;
		align-items: center;
		gap: 10px;
		padding: 9px 10px;
		border: 0;
		border-radius: var(--sonora-radius-md);
		background: transparent;
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-md);
		text-align: left;
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
		background: var(--sonora-bg-active);
		color: var(--sonora-text);
	}
	.sidebar nav button span,
	.sidebar section button span {
		flex: 1;
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.sidebar nav button b,
	.sidebar section button b {
		font-weight: 600;
		font-size: var(--sonora-text-sm);
		opacity: 0.7;
	}
	.folder-summary {
		display: flex;
		align-items: flex-start;
		gap: 10px;
		padding: 12px 10px;
		margin-bottom: 16px;
		border-radius: var(--sonora-radius-md);
		background: rgba(255, 255, 255, 0.03);
		color: var(--sonora-text-muted);
	}
	.folder-summary strong {
		display: block;
		color: var(--sonora-text);
		font-size: var(--sonora-text-md);
		font-weight: 600;
	}
	.folder-summary span {
		font-size: var(--sonora-text-sm);
	}
	.sidebar section h2 {
		margin: 0 0 8px 10px;
		font-size: var(--sonora-text-sm);
		font-weight: 650;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sonora-text-faint);
	}
	.main {
		min-width: 0;
		overflow-y: auto;
		padding: 24px 28px 40px;
	}
	.toolbar {
		display: flex;
		align-items: flex-end;
		justify-content: space-between;
		gap: 16px;
		margin-bottom: 22px;
	}
	.toolbar h1 {
		margin: 0 0 4px;
		font-size: 22px;
		font-weight: 700;
		letter-spacing: var(--sonora-tracking-tight);
	}
	.toolbar span {
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-md);
	}
	.toolbar-actions {
		display: flex;
		align-items: center;
		gap: 10px;
	}
	.seg {
		display: flex;
		gap: 2px;
		padding: 3px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-surface-raised);
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
		gap: calc(var(--sonora-space) * 2) var(--sonora-space);
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
		background: radial-gradient(
			circle at 30% 30%,
			var(--sonora-accent-soft),
			transparent 70%
		);
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
		font-size: var(--sonora-text-md);
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
		.score-grid {
			grid-template-columns: repeat(2, minmax(0, 1fr));
			gap: 18px 10px;
		}
	}
</style>
