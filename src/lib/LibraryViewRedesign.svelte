<script lang="ts">
	import { onMount } from 'svelte';
	import {
		Check,
		Clock3,
		FileText,
		FolderOpen,
		FolderPlus,
		Grid2X2,
		List,
		MoreHorizontal,
		Music2,
		RefreshCw,
		Search,
		Star,
		Tag,
		Trash2,
		X
	} from '@lucide/svelte';
	import { db } from './db';
	import { chooseAndAddFolder, resolveScoreSource, syncAllFolders } from './folderSync';
	import { getComposerPortrait } from './composerPortraits';
	import { getPdfInfoFromSource } from './pdfUtils';
	import { isTauri } from './paths';
	import type { FolderSource, ScoreItem } from './types';

	const THUMBNAIL_VERSION = 2;

	let { onSelectScore, paused = false }: { onSelectScore: (score: ScoreItem) => void; paused?: boolean } = $props();
	let scores = $state<ScoreItem[]>([]);
	let folder = $state<FolderSource | undefined>();
	let search = $state('');
	let filter = $state<'all' | 'favorites' | 'recent'>('all');
	let composer = $state<string | null>(null);
	let sort = $state<'recent' | 'title' | 'composer'>('recent');
	let view = $state<'grid' | 'list'>('grid');
	let menuScoreId = $state<string | null>(null);
	let metadata = $state<ScoreItem | null>(null);
	let tagDraft = $state('');
	let editingTags = $state<string[]>([]);
	let syncing = $state(false);
	let notice = $state('');
	let error = $state('');
	let openingId = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | undefined;
	let backfillRunning = false;

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
			if ((e as DOMException)?.name !== 'AbortError') {
				error = e instanceof Error ? e.message : 'Could not choose the score folder';
			}
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
			if (!prepared.pdfUrl && !prepared.nativePath && !(prepared.pdfBlob && prepared.pdfBlob.size > 0)) {
				throw new Error(`“${score.title}” has no PDF source. Try refreshing the library.`);
			}
			const openedAt = Date.now();
			void db.scores.update(score.id, { lastOpenedAt: openedAt }).catch((err) =>
				console.warn('Could not update last opened', err)
			);
			scores = scores.map((item) => item.id === score.id ? { ...item, lastOpenedAt: openedAt } : item);
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
		scores = scores.map((item) => item.id === score.id ? { ...item, favorite } : item);
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
		editingTags = [...(score.tags ?? [])];
		tagDraft = '';
	}

	function addTag(value = tagDraft) {
		const tag = value.trim().replace(/,+$/, '').trim();
		if (!tag) return;
		if (!editingTags.some((existing) => existing.toLowerCase() === tag.toLowerCase())) {
			editingTags = [...editingTags, tag];
		}
		tagDraft = '';
	}

	function handleTagInput(event: KeyboardEvent) {
		if (event.key === 'Enter' || event.key === ',') {
			event.preventDefault();
			addTag();
		} else if (event.key === 'Backspace' && !tagDraft && editingTags.length) {
			editingTags = editingTags.slice(0, -1);
		}
	}

	function removeTag(tag: string) {
		editingTags = editingTags.filter((item) => item !== tag);
	}

	async function saveMetadata() {
		if (!metadata) return;
		const tags = editingTags.map((tag) => tag.trim()).filter(Boolean);
		try {
			await db.scores.update(metadata.id, { tags });
			scores = scores.map((item) => item.id === metadata!.id ? { ...item, tags } : item);
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
			const missing = scores.filter((score) => !score.thumbnailUrl || score.thumbnailVersion !== THUMBNAIL_VERSION);
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
					scores = scores.map((item) => item.id === score.id
						? { ...item, thumbnailUrl: info.thumbnailUrl, thumbnailVersion: THUMBNAIL_VERSION, totalPages: info.totalPages || item.totalPages || 1 }
						: item
					);
				} catch (err) {
					console.warn('Thumbnail backfill failed', score.title, err);
				}
				await new Promise<void>((resolve) => setTimeout(resolve, 24));
			}
			if (!paused && scores.some((score) => !score.thumbnailUrl || score.thumbnailVersion !== THUMBNAIL_VERSION)) {
				setTimeout(() => void backfillThumbnails(), 700);
			}
		} finally {
			backfillRunning = false;
		}
	}

	function initials(name: string) {
		return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase();
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

	const allTags = $derived(Array.from(new Set(scores.flatMap((score) => score.tags ?? []))).sort((a, b) => a.localeCompare(b)));

	const filtered = $derived(
		scores
			.filter((score) => !composer || score.composer === composer)
			.filter((score) => filter === 'all' || (filter === 'favorites' ? !!score.favorite : !!score.lastOpenedAt))
			.filter((score) => {
				const query = search.trim().toLowerCase();
				return !query || score.title.toLowerCase().includes(query) || score.composer.toLowerCase().includes(query) || (score.tags ?? []).some((tag) => tag.toLowerCase().includes(query));
			})
			.sort((a, b) => sort === 'title'
				? a.title.localeCompare(b.title)
				: sort === 'composer'
					? a.composer.localeCompare(b.composer) || a.title.localeCompare(b.title)
					: (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt)
			)
	);

	const currentTitle = $derived(composer ? composer : filter === 'favorites' ? 'Favorites' : filter === 'recent' ? 'Recently opened' : 'All scores');
	const tagSuggestions = $derived(allTags.filter((tag) => !editingTags.some((existing) => existing.toLowerCase() === tag.toLowerCase()) && (!tagDraft.trim() || tag.toLowerCase().includes(tagDraft.trim().toLowerCase()))).slice(0, 8));
</script>

<svelte:window
	onclick={() => closeMenu()}
	onkeydown={(event) => {
		if (event.key === 'Escape') {
			closeMenu();
			if (metadata) metadata = null;
		}
	}}
/>

<div class="library">
	<header class="header">
		<div class="brand"><div class="brand-mark"><Music2 size={19} /></div><strong>Sonora</strong></div>
		<div class="search"><Search size={17} /><input bind:value={search} placeholder="Search your scores" aria-label="Search scores" />{#if search}<button onclick={(event) => { event.stopPropagation(); search = ''; }} aria-label="Clear search"><X size={15} /></button>{/if}</div>
		<div class="header-actions">
			<button class="folder-button" onclick={chooseFolder}><FolderPlus size={17} /><span>{folder ? 'Change folder' : 'Choose folder'}</span></button>
			<button class="icon-button" class:spinning={syncing} onclick={sync} aria-label="Refresh library" title="Refresh library"><RefreshCw size={18} /></button>
		</div>
	</header>

	{#if error}<div class="notice error"><span>{error}</span><button onclick={() => (error = '')} aria-label="Dismiss"><X size={15} /></button></div>{/if}
	{#if notice}<div class="notice"><Check size={15} />{notice}</div>{/if}

	<div class="body">
		<aside class="sidebar">
			<nav aria-label="Library filters">
				<button class:active={filter === 'all' && !composer} onclick={() => { filter = 'all'; composer = null; }}><Grid2X2 size={16} /><span>All scores</span><b>{scores.length}</b></button>
				<button class:active={filter === 'recent'} onclick={() => { filter = 'recent'; composer = null; }}><Clock3 size={16} /><span>Recently opened</span></button>
				<button class:active={filter === 'favorites'} onclick={() => { filter = 'favorites'; composer = null; }}><Star size={16} /><span>Favorites</span></button>
			</nav>
			{#if folder}<div class="folder-summary"><FolderOpen size={16} /><div><strong>{folder.name}</strong><span>{scores.length} {scores.length === 1 ? 'score' : 'scores'}</span></div></div>{/if}
			{#if Object.keys(composers).length}<section><h2>Composers</h2>{#each Object.entries(composers).sort((a, b) => a[0].localeCompare(b[0])).slice(0, 16) as [name, count]}{@const portrait = getComposerPortrait(name)}<button class:active={composer === name} onclick={() => { composer = name; filter = 'all'; }}><div class="portrait">{#if portrait}<img src={portrait} alt="" loading="lazy" onerror={(event) => { (event.currentTarget as HTMLImageElement).style.display = 'none'; }} />{/if}<span>{initials(name)}</span></div><span>{name}</span><b>{count}</b></button>{/each}</section>{/if}
		</aside>

		<main class="main">
			<div class="toolbar">
				<div><h1>{currentTitle}</h1><span>{filtered.length} {filtered.length === 1 ? 'score' : 'scores'}</span></div>
				<div class="toolbar-actions">
					<select class="sort-select" bind:value={sort} aria-label="Sort scores"><option value="recent">Recently used</option><option value="title">Title</option><option value="composer">Composer</option></select>
					<div class="seg"><button class:active={view === 'grid'} onclick={() => (view = 'grid')} aria-label="Grid view"><Grid2X2 size={16} /></button><button class:active={view === 'list'} onclick={() => (view = 'list')} aria-label="List view"><List size={16} /></button></div>
				</div>
			</div>

			{#if !folder && !scores.length}
				<div class="empty"><div class="empty-icon"><FolderOpen size={30} /></div><h2>Your score library</h2><p>Choose one folder where Sonora will keep all of your scores.</p><button class="primary" onclick={chooseFolder}><FolderPlus size={17} />Choose score folder</button></div>
			{:else if filtered.length === 0}
				<div class="empty"><div class="empty-icon"><Search size={28} /></div><h2>No scores found</h2><p>Try another search or filter, or refresh the library.</p></div>
			{:else if view === 'list'}
				<div class="score-list">
					{#each filtered as score (score.id)}
						<div class="list-row" class:opening={openingId === score.id} role="button" tabindex="0" onclick={() => openScore(score)} onkeydown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void openScore(score); } }}>
							<div class="list-cover">{#if score.thumbnailUrl}<img src={score.thumbnailUrl} alt="" />{:else}<FileText size={22} />{/if}</div>
							<div class="list-info"><strong title={score.title}>{score.title}</strong><span>{score.composer}</span>{#if score.tags?.length}<div class="tags">{#each score.tags.slice(0, 3) as tag}<span>{tag}</span>{/each}{#if score.tags.length > 3}<small>+{score.tags.length - 3}</small>{/if}</div>{/if}</div>
							<div class="list-meta"><span>{score.totalPages || 1} {score.totalPages === 1 ? 'page' : 'pages'}</span>{#if score.lastOpenedAt}<span>Recent</span>{/if}</div>
							<div class="list-actions" onclick={(event) => event.stopPropagation()}>
								<button class="action-button favorite" class:marked={score.favorite} onclick={(event) => toggleFavorite(score, event)} aria-label={score.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={score.favorite} title={score.favorite ? 'Remove from favorites' : 'Add to favorites'}><Star size={16} fill={score.favorite ? 'currentColor' : 'none'} /></button>
								{#if !score.favorite}<div class="menu-wrap"><button class="action-button" class:active={menuScoreId === score.id} onclick={(event) => toggleMenu(score, event)} aria-label="More actions" aria-expanded={menuScoreId === score.id}><MoreHorizontal size={17} /></button>{#if menuScoreId === score.id}<div class="score-menu" role="menu"><button role="menuitem" onclick={(event) => editMetadata(score, event)}><Tag size={15} />Edit tags</button><button class="danger" role="menuitem" onclick={(event) => deleteScore(score, event)}><Trash2 size={15} />Remove from library</button></div>{/if}</div>{/if}
							</div>
						</div>
					{/each}
				</div>
			{:else}
				<div class="score-grid">
					{#each filtered as score (score.id)}
						<div class="card" class:opening={openingId === score.id}>
							<button class="score-open" onclick={() => void openScore(score)} aria-label={`Open ${score.title}`}>
								<div class="cover">{#if score.thumbnailUrl}<img src={score.thumbnailUrl} alt="" loading="eager" decoding="async" />{:else}<div class="no-cover"><FileText size={25} /><span>{score.totalPages ? `${score.totalPages} pages` : 'Preparing preview'}</span></div>{/if}</div>
								<div class="info"><h3 title={score.title}>{score.title}</h3><p>{score.composer}</p>{#if score.tags?.length}<div class="tags">{#each score.tags.slice(0, 2) as tag}<span>{tag}</span>{/each}{#if score.tags.length > 2}<small>+{score.tags.length - 2}</small>{/if}</div>{/if}</div>
							</button>
							<div class="card-actions" onclick={(event) => event.stopPropagation()}>
								<button class="action-button favorite" class:marked={score.favorite} onclick={(event) => toggleFavorite(score, event)} aria-label={score.favorite ? 'Remove from favorites' : 'Add to favorites'} aria-pressed={score.favorite} title={score.favorite ? 'Remove from favorites' : 'Add to favorites'}><Star size={16} fill={score.favorite ? 'currentColor' : 'none'} /></button>
								{#if !score.favorite}<div class="menu-wrap"><button class="action-button" class:active={menuScoreId === score.id} onclick={(event) => toggleMenu(score, event)} aria-label="More actions" aria-expanded={menuScoreId === score.id} title="More actions"><MoreHorizontal size={17} /></button>{#if menuScoreId === score.id}<div class="score-menu" role="menu"><button role="menuitem" onclick={(event) => editMetadata(score, event)}><Tag size={15} />Edit tags</button><button class="danger" role="menuitem" onclick={(event) => deleteScore(score, event)}><Trash2 size={15} />Remove from library</button></div>{/if}</div>{/if}
							</div>
						</div>
					{/each}
				</div>
			{/if}
		</main>
	</div>

	{#if metadata}
		<div class="dialog-backdrop" role="presentation" onclick={(event) => { if (event.currentTarget === event.target) metadata = null; }}>
			<section class="tag-dialog" role="dialog" aria-modal="true" aria-labelledby="tag-dialog-title" onclick={(event) => event.stopPropagation()}>
				<header><div><h2 id="tag-dialog-title">Edit tags</h2><p>{metadata.title}</p></div><button class="close-button" onclick={() => (metadata = null)} aria-label="Close"><X size={18} /></button></header>
				<div class="tag-editor">
					<label for="tag-input">Tags</label>
					<div class="tag-input-wrap" class:has-tags={editingTags.length > 0}>
						{#each editingTags as tag}<span class="edit-tag">{tag}<button onclick={() => removeTag(tag)} aria-label={`Remove ${tag}`}><X size={12} /></button></span>{/each}
						<input id="tag-input" bind:value={tagDraft} onkeydown={handleTagInput} onblur={() => addTag()} placeholder={editingTags.length ? 'Add another tag…' : 'Type a tag and press Enter…'} />
					</div>
					{#if tagSuggestions.length}<div class="suggestions"><span>Suggestions</span>{#each tagSuggestions as tag}<button onclick={() => addTag(tag)}>{tag}</button>{/each}</div>{/if}
					<div class="tag-help"><Tag size={14} /><span>Press Enter or type a comma to add a tag.</span>{#if editingTags.length}<button onclick={() => (editingTags = [])}>Clear all</button>{/if}</div>
				</div>
				<footer><button class="secondary" onclick={() => (metadata = null)}>Cancel</button><button class="primary" onclick={saveMetadata}><Check size={16} />Save changes</button></footer>
			</section>
		</div>
	{/if}
</div>

<style>
	.library { height:100%; width:100%; display:flex; flex-direction:column; background:#11110f; color:#f5f5f4; overflow:hidden; }
	.header { height:70px; flex:0 0 70px; display:grid; grid-template-columns:220px minmax(220px,560px) 220px; align-items:center; justify-content:space-between; gap:24px; padding:0 28px; border-bottom:1px solid #282824; background:#151512; }
	.brand { display:flex; align-items:center; gap:10px; min-width:0; }
	.brand strong { font-size:17px; letter-spacing:-.02em; }
	.brand-mark { width:34px; height:34px; display:grid; place-items:center; border:1px solid #35352f; border-radius:10px; background:#1d1d19; color:#d8d8d0; }
	.search { height:40px; display:flex; align-items:center; gap:9px; padding:0 11px; border:1px solid #30302b; border-radius:11px; background:#1b1b18; color:#77776f; }
	.search:focus-within { border-color:#57574f; background:#1d1d19; }
	.search input { min-width:0; flex:1; border:0; outline:0; background:transparent; color:#e7e7df; font-size:13px; }
	.search input::placeholder { color:#66665f; }
	.search button { width:26px; height:26px; display:grid; place-items:center; border:0; border-radius:7px; background:transparent; color:#77776f; cursor:pointer; }
	.search button:hover { background:#292923; color:#ddd; }
	.header-actions { display:flex; justify-content:flex-end; align-items:center; gap:8px; }
	.folder-button, .primary { display:inline-flex; align-items:center; justify-content:center; gap:8px; border:1px solid #3c3c35; border-radius:10px; background:#e6e6de; color:#171713; padding:9px 13px; font-size:12px; font-weight:650; cursor:pointer; }
	.folder-button:hover, .primary:hover { background:#f0f0e8; }
	.icon-button, .close-button { display:grid; place-items:center; width:38px; height:38px; border:1px solid #30302b; border-radius:10px; background:#1b1b18; color:#a2a29a; cursor:pointer; }
	.icon-button:hover, .close-button:hover { background:#24241f; color:#eee; }
	.spinning svg { animation:spin .8s linear infinite; }
	.notice { margin:10px auto 0; display:flex; align-items:center; gap:7px; padding:8px 11px; border:1px solid #34342e; border-radius:9px; background:#1c1c18; color:#bdbdb5; font-size:12px; }
	.notice.error { border-color:#593b32; color:#e5b7a8; }
	.notice button { margin-left:8px; border:0; background:transparent; color:inherit; cursor:pointer; }
	.body { min-height:0; flex:1; display:grid; grid-template-columns:220px minmax(0,1fr); }
	.sidebar { min-height:0; overflow:auto; padding:22px 14px; border-right:1px solid #282824; background:#141411; }
	.sidebar nav, .sidebar section { display:flex; flex-direction:column; gap:3px; }
	.sidebar section { margin-top:25px; }
	.sidebar h2 { margin:0 10px 8px; color:#62625b; font-size:10px; text-transform:uppercase; letter-spacing:.12em; font-weight:700; }
	.sidebar nav button, .sidebar section button { min-width:0; width:100%; display:flex; align-items:center; gap:10px; border:0; border-radius:9px; padding:8px 10px; background:transparent; color:#8f8f87; text-align:left; font-size:12px; cursor:pointer; }
	.sidebar nav button:hover, .sidebar section button:hover, .sidebar nav button.active, .sidebar section button.active { background:#1f1f1b; color:#e4e4dc; }
	.sidebar button span:not(.portrait span) { min-width:0; flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.sidebar button b { color:#5f5f58; font-size:10px; font-weight:500; }
	.folder-summary { display:flex; gap:10px; align-items:center; margin:22px 5px 0; padding:11px 9px; border:1px solid #282824; border-radius:10px; background:#191916; color:#797971; }
	.folder-summary div { min-width:0; display:flex; flex-direction:column; gap:2px; }
	.folder-summary strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#b4b4ac; font-size:11px; }
	.folder-summary span { font-size:10px; color:#5f5f58; }
	.portrait { position:relative; flex:0 0 28px; width:28px; height:28px; display:grid; place-items:center; overflow:hidden; border:1px solid #30302b; border-radius:8px; background:#20201c; color:#77776e; font-size:9px; font-weight:700; }
	.portrait img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
	.main { min-width:0; min-height:0; overflow:auto; padding:28px 32px 42px; }
	.toolbar { display:flex; align-items:flex-end; justify-content:space-between; gap:18px; margin-bottom:24px; }
	.toolbar h1 { margin:0; font-size:23px; line-height:1.1; letter-spacing:-.03em; font-weight:650; }
	.toolbar > div:first-child span { display:block; margin-top:6px; color:#66665f; font-size:11px; }
	.toolbar-actions { display:flex; align-items:center; gap:8px; }
	.sort-select { height:36px; border:1px solid #30302b; border-radius:9px; padding:0 10px; background:#1a1a17; color:#a6a69e; outline:0; font-size:11px; }
	.sort-select:focus { border-color:#55554d; }
	.seg { display:flex; gap:2px; padding:3px; border:1px solid #30302b; border-radius:10px; background:#1a1a17; }
	.seg button { width:31px; height:30px; display:grid; place-items:center; border:0; border-radius:7px; background:transparent; color:#66665f; cursor:pointer; }
	.seg button:hover, .seg button.active { background:#292923; color:#ddd; }
	.score-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:24px 18px; }
	.card { position:relative; min-width:0; }
	.card.opening { opacity:.55; }
	.score-open { display:block; width:100%; padding:0; border:0; background:transparent; color:inherit; text-align:left; cursor:pointer; }
	.cover { position:relative; aspect-ratio:3/4; overflow:hidden; border:1px solid #2d2d28; border-radius:9px; background:#191916; box-shadow:0 7px 20px #0005; }
	.cover img { width:100%; height:100%; display:block; object-fit:cover; object-position:top; background:#fff; transition:transform .18s ease; }
	.card:hover .cover img { transform:scale(1.012); }
	.no-cover { width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; color:#5f5f58; font-size:10px; }
	.info { padding:10px 2px 0; }
	.info h3 { margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#d7d7cf; font-size:12px; font-weight:600; }
	.info p { margin:4px 0 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#696961; font-size:10px; }
	.tags { display:flex; gap:4px; margin-top:7px; overflow:hidden; }
	.tags span, .tags small { flex:0 0 auto; max-width:85px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; padding:3px 6px; border:1px solid #2c2c27; border-radius:5px; background:#1a1a17; color:#73736b; font-size:9px; }
	.tags small { border:0; padding:3px 2px; background:transparent; color:#55554e; }
	.card-actions { position:absolute; top:7px; right:7px; display:flex; align-items:center; gap:4px; padding:3px; border:1px solid #34342e; border-radius:9px; background:#151512dd; backdrop-filter:blur(9px); opacity:0; transform:translateY(-2px); transition:opacity .14s ease,transform .14s ease; }
	.card:hover .card-actions, .card:focus-within .card-actions, .card-actions:has(.favorite.marked) { opacity:1; transform:none; }
	.action-button { width:30px; height:30px; display:grid; place-items:center; border:0; border-radius:7px; background:transparent; color:#85857d; cursor:pointer; }
	.action-button:hover, .action-button.active { background:#292923; color:#e6e6de; }
	.action-button.favorite:hover, .action-button.favorite.marked { color:#e1b94b; }
	.action-button.favorite.marked:hover { background:#2b281d; }
	.menu-wrap { position:relative; }
	.score-menu { position:absolute; z-index:50; top:calc(100% + 6px); right:0; width:174px; padding:4px; border:1px solid #35352f; border-radius:10px; background:#1a1a17; box-shadow:0 12px 28px #0008; }
	.score-menu button { width:100%; display:flex; align-items:center; gap:9px; padding:8px 9px; border:0; border-radius:7px; background:transparent; color:#aaa9a1; text-align:left; font-size:11px; cursor:pointer; }
	.score-menu button:hover { background:#292923; color:#eee; }
	.score-menu button.danger:hover { background:#32211d; color:#e5aa98; }
	.score-list { display:flex; flex-direction:column; border:1px solid #292923; border-radius:12px; overflow:visible; background:#171714; }
	.list-row { position:relative; min-width:0; display:grid; grid-template-columns:46px minmax(0,1fr) auto auto; align-items:center; gap:14px; padding:9px 11px; border-bottom:1px solid #282824; cursor:pointer; }
	.list-row:last-child { border-bottom:0; }
	.list-row:hover, .list-row:focus-visible { background:#1d1d19; outline:0; }
	.list-row.opening { opacity:.55; }
	.list-cover { width:46px; height:58px; display:grid; place-items:center; overflow:hidden; border:1px solid #2d2d28; border-radius:6px; background:#10100e; color:#55554e; }
	.list-cover img { width:100%; height:100%; object-fit:cover; object-position:top; }
	.list-info { min-width:0; }
	.list-info strong, .list-info > span { display:block; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
	.list-info strong { color:#d8d8d0; font-size:12px; font-weight:600; }
	.list-info > span { margin-top:4px; color:#686860; font-size:10px; }
	.list-meta { display:flex; flex-direction:column; align-items:flex-end; gap:4px; color:#5f5f58; font-size:9px; white-space:nowrap; }
	.list-actions { display:flex; align-items:center; gap:3px; }
	.empty { min-height:360px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; border:1px dashed #34342e; border-radius:14px; color:#67675f; text-align:center; }
	.empty-icon { width:58px; height:58px; display:grid; place-items:center; margin-bottom:4px; border:1px solid #30302b; border-radius:15px; background:#1a1a17; color:#77776e; }
	.empty h2 { margin:0; color:#c5c5bd; font-size:16px; }
	.empty p { max-width:360px; margin:0 0 10px; color:#66665f; font-size:11px; }
	.dialog-backdrop { position:fixed; inset:0; z-index:100; display:flex; align-items:center; justify-content:center; padding:20px; background:#0009; backdrop-filter:blur(5px); }
	.tag-dialog { width:min(500px,100%); border:1px solid #3a3a34; border-radius:15px; background:#1a1a17; box-shadow:0 24px 70px #000b; overflow:hidden; }
	.tag-dialog > header { height:auto; display:flex; align-items:center; justify-content:space-between; gap:16px; padding:18px 18px 15px; border-bottom:1px solid #2d2d28; background:#1c1c19; }
	.tag-dialog header h2 { margin:0; color:#e4e4dc; font-size:15px; }
	.tag-dialog header p { margin:5px 0 0; max-width:360px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; color:#66665f; font-size:10px; }
	.tag-editor { padding:18px; }
	.tag-editor > label { display:block; margin-bottom:7px; color:#9d9d95; font-size:11px; font-weight:600; }
	.tag-input-wrap { min-height:46px; display:flex; align-items:center; flex-wrap:wrap; gap:6px; padding:7px 9px; border:1px solid #35352f; border-radius:10px; background:#11110f; }
	.tag-input-wrap:focus-within { border-color:#5b5b52; box-shadow:0 0 0 2px #ffffff08; }
	.tag-input-wrap input { flex:1 1 120px; min-width:100px; border:0; outline:0; background:transparent; color:#ddd; font-size:11px; }
	.tag-input-wrap input::placeholder { color:#55554e; }
	.edit-tag { display:inline-flex; align-items:center; gap:4px; max-width:170px; padding:5px 7px; border:1px solid #3a3931; border-radius:6px; background:#25251f; color:#c0c0b7; font-size:10px; }
	.edit-tag button { display:grid; place-items:center; padding:1px; border:0; border-radius:4px; background:transparent; color:#77776f; cursor:pointer; }
	.edit-tag button:hover { background:#35352f; color:#eee; }
	.suggestions { display:flex; align-items:center; flex-wrap:wrap; gap:5px; margin-top:10px; }
	.suggestions > span { margin-right:3px; color:#55554e; font-size:9px; }
	.suggestions button { padding:5px 7px; border:1px solid #2e2e29; border-radius:6px; background:#1d1d19; color:#77776f; font-size:9px; cursor:pointer; }
	.suggestions button:hover { border-color:#45453d; color:#c7c7bf; }
	.tag-help { display:flex; align-items:center; gap:6px; margin-top:14px; color:#5f5f58; font-size:9px; }
	.tag-help button { margin-left:auto; border:0; background:transparent; color:#77776f; font-size:9px; cursor:pointer; }
	.tag-help button:hover { color:#d5d5cd; }
	.tag-dialog > footer { display:flex; justify-content:flex-end; gap:8px; padding:13px 18px; border-top:1px solid #2d2d28; background:#181815; }
	.secondary { display:inline-flex; align-items:center; gap:7px; border:1px solid #33332e; border-radius:9px; padding:8px 12px; background:#22221e; color:#9d9d95; font-size:11px; cursor:pointer; }
	.secondary:hover { background:#2a2a25; color:#ddd; }
	@keyframes spin { to { transform:rotate(360deg); } }
	@media (max-width:900px) {
		.header { grid-template-columns:auto minmax(0,1fr) auto; gap:12px; padding:0 18px; }
		.sidebar { width:190px; }
		.body { grid-template-columns:190px minmax(0,1fr); }
		.main { padding:22px 20px 34px; }
		.folder-button span { display:none; }
	}
	@media (max-width:680px) {
		.header { height:62px; flex-basis:62px; grid-template-columns:auto minmax(0,1fr) auto; padding:0 12px; }
		.brand strong { display:none; }
		.body { display:block; }
		.sidebar { display:none; }
		.main { padding:17px 12px 30px; }
		.toolbar { align-items:center; margin-bottom:18px; }
		.sort-select { display:none; }
		.score-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px 11px; }
		.list-row { grid-template-columns:42px minmax(0,1fr) auto; gap:10px; }
		.list-meta { display:none; }
		.list-cover { width:42px; height:54px; }
		.list-actions .action-button { width:28px; height:28px; }
		.list-info .tags { display:none; }
	}
	@media (prefers-reduced-motion:reduce) { .card-actions, .cover img { transition:none; } :global(.spinning svg) { animation:none; } }
</style>
