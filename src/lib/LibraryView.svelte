<script lang="ts">
	import { onMount } from 'svelte';
	import {
		FolderOpen, FolderPlus, Grid2X2, List, MoreHorizontal, Music2, RefreshCw,
		Search, Star, Clock3, X, FileText, Check
	} from '@lucide/svelte';
	import { db } from './db';
	import { chooseAndAddFolder, syncAllFolders, resolveScoreSource } from './folderSync';
	import { getComposerPortrait } from './composerPortraits';
	import { getPdfInfoFromSource } from './pdfUtils';
	import { isTauri } from './paths';
	import type { FolderSource, ScoreItem } from './types';

	let { onSelectScore, paused = false }: { onSelectScore: (score: ScoreItem) => void; paused?: boolean } = $props();
	let scores = $state<ScoreItem[]>([]);
	let folder = $state<FolderSource | undefined>();
	let search = $state('');
	let filter = $state<'all' | 'favorites' | 'recent'>('all');
	let composer = $state<string | null>(null);
	let sort = $state<'recent' | 'title' | 'composer'>('recent');
	let view = $state<'grid' | 'list'>('grid');
	let metadata = $state<ScoreItem | null>(null);
	let newTags = $state('');
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
		if (syncing) return;
		syncing = true;
		error = '';
		try {
			const results = await syncAllFolders();
			const result = results[0];
			notice = result ? result.added || result.updated || result.removed ? `${result.added + result.updated} updated · ${result.removed} removed` : 'Library is up to date' : 'Choose a score folder to begin';
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
			if ((e as DOMException)?.name !== 'AbortError') error = e instanceof Error ? e.message : 'Could not choose the score folder';
		}
	}

	function prepareScore(score: ScoreItem): ScoreItem {
		const source = resolveScoreSource(score, folder);
		return { ...score, pdfUrl: source.url || score.pdfUrl, nativePath: source.nativePath || score.nativePath, pdfBlob: isTauri() ? undefined : source.blob || score.pdfBlob };
	}

	async function openScore(score: ScoreItem) {
		error = '';
		openingId = score.id;
		try {
			const prepared = prepareScore(score);
			if (!prepared.pdfUrl && !prepared.nativePath && !(prepared.pdfBlob && prepared.pdfBlob.size > 0)) throw new Error(`“${score.title}” has no PDF source. Try refreshing the library.`);
			const openedAt = Date.now();
			void db.scores.update(score.id, { lastOpenedAt: openedAt }).catch((err) => console.warn('Could not update last opened', err));
			scores = scores.map((item) => item.id === score.id ? { ...item, lastOpenedAt: openedAt } : item);
			onSelectScore({ ...prepared, lastOpenedAt: openedAt });
		} catch (e) {
			console.error('Open score failed', e);
			error = e instanceof Error ? e.message : 'Could not open this score';
		} finally { openingId = null; }
	}

	function yieldToMain() {
		return new Promise<void>((resolve) => {
			if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 200 });
			else setTimeout(resolve, 24);
		});
	}

	async function backfillThumbnails() {
		if (backfillRunning || paused) return;
		backfillRunning = true;
		try {
			const missing = scores.filter((s) => !s.thumbnailUrl);
			if (!missing.length) return;
			// Keep the first pass deliberately small so a large music library never
			// monopolizes the UI thread. Continue in short batches after yielding.
			for (const score of missing.slice(0, 4)) {
				if (paused) break;
				try {
					const source = resolveScoreSource(score, folder);
					if (!source.url && !source.blob && !source.nativePath) continue;
					const info = await getPdfInfoFromSource(source);
					await db.scores.update(score.id, {
						thumbnailUrl: info.thumbnailUrl,
						totalPages: info.totalPages || score.totalPages || 1
					});
					scores = scores.map((item) => item.id === score.id ? { ...item, thumbnailUrl: info.thumbnailUrl, totalPages: info.totalPages || item.totalPages || 1 } : item);
				} catch (err) {
					console.warn('Thumbnail backfill failed', score.title, err);
				}
				await yieldToMain();
			}
			if (!paused && scores.some((s) => !s.thumbnailUrl)) setTimeout(() => void backfillThumbnails(), 700);
		} finally { backfillRunning = false; }
	}

	async function toggleFavorite(score: ScoreItem, event: MouseEvent) {
		event.stopPropagation();
		const next = { ...score, favorite: !score.favorite };
		await db.scores.update(score.id, { favorite: next.favorite });
		scores = scores.map((item) => item.id === score.id ? next : item);
	}
	function editMetadata(score: ScoreItem, event: MouseEvent) { event.stopPropagation(); metadata = score; newTags = (score.tags ?? []).join(', '); }
	async function saveMetadata() { if (!metadata) return; const tags = newTags.split(',').map((tag) => tag.trim()).filter(Boolean); await db.scores.update(metadata.id, { tags }); scores = scores.map((item) => item.id === metadata!.id ? { ...item, tags } : item); metadata = null; }
	async function deleteScore(score: ScoreItem, event: MouseEvent) { event.stopPropagation(); if (!confirm(`Remove “${score.title}” from Sonora?`)) return; await db.transaction('rw', db.scores, db.annotations, async () => { await db.scores.delete(score.id); await db.annotations.where('scoreId').equals(score.id).delete(); }); scores = scores.filter((item) => item.id !== score.id); }
	function initials(name: string) { return name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('').toUpperCase(); }
	function hideBrokenImage(event: Event) { const img = event.currentTarget as HTMLImageElement; img.style.display = 'none'; img.removeAttribute('src'); }

	onMount(() => {
		let disposed = false;
		const initialize = async () => {
			await refresh();
			if (disposed) return;
			const saved = localStorage.getItem('sonora-library-settings');
			if (saved) {
				try { const value = JSON.parse(saved); view = value.view === 'list' ? 'list' : 'grid'; sort = ['recent', 'title', 'composer'].includes(value.sort) ? value.sort : 'recent'; } catch {}
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
		return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', wake); };
	});

	$effect(() => { localStorage.setItem('sonora-library-settings', JSON.stringify({ view, sort })); });
	$effect(() => { if (!paused) void backfillThumbnails(); });

	const composers = $derived.by(() => { const counts: Record<string, number> = {}; for (const score of scores) { const name = score.composer || 'Unknown Composer'; counts[name] = (counts[name] ?? 0) + 1; } return counts; });
	const filtered = $derived(scores.filter((score) => !composer || score.composer === composer).filter((score) => filter === 'all' || (filter === 'favorites' ? !!score.favorite : !!score.lastOpenedAt)).filter((score) => { const query = search.trim().toLowerCase(); return !query || score.title.toLowerCase().includes(query) || score.composer.toLowerCase().includes(query) || (score.tags ?? []).some((tag) => tag.toLowerCase().includes(query)); }).sort((a, b) => sort === 'title' ? a.title.localeCompare(b.title) : sort === 'composer' ? a.composer.localeCompare(b.composer) || a.title.localeCompare(b.title) : (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt)));
	const currentTitle = $derived(composer ? composer : filter === 'favorites' ? 'Favorites' : filter === 'recent' ? 'Recently opened' : 'All scores');
</script>

<div class="library">
	<header class="header">
		<div class="brand"><div class="brand-mark"><Music2 size={20} /></div><strong>Sonora</strong></div>
		<div class="search"><Search size={17} /><input bind:value={search} placeholder="Search your scores" aria-label="Search scores" />{#if search}<button onclick={() => (search = '')} aria-label="Clear search"><X size={15} /></button>{/if}</div>
		<div class="actions"><button class="folder-button" onclick={chooseFolder} title="Choose the folder containing your scores"><FolderPlus size={17} /><span>{folder ? 'Change folder' : 'Choose folder'}</span></button><button class="icon-button" class:spinning={syncing} onclick={sync} title="Refresh library" aria-label="Refresh library"><RefreshCw size={18} /></button></div>
	</header>
	{#if error}<div class="notice error"><span>{error}</span><button onclick={() => (error = '')} aria-label="Dismiss"><X size={15} /></button></div>{/if}
	{#if notice}<div class="notice"><Check size={15} />{notice}</div>{/if}
	<div class="body">
		<aside class="sidebar">
			<nav aria-label="Library filters"><button class:active={filter === 'all' && !composer} onclick={() => { filter = 'all'; composer = null; }}><Grid2X2 size={16} /><span>All scores</span><b>{scores.length}</b></button><button class:active={filter === 'recent'} onclick={() => { filter = 'recent'; composer = null; }}><Clock3 size={16} /><span>Recently opened</span></button><button class:active={filter === 'favorites'} onclick={() => { filter = 'favorites'; composer = null; }}><Star size={16} /><span>Favorites</span></button></nav>
			{#if folder}<div class="folder-summary"><FolderOpen size={16} /><div><strong>{folder.name}</strong><span>{scores.length} {scores.length === 1 ? 'score' : 'scores'}</span></div></div>{/if}
			{#if Object.keys(composers).length}<section><h2>Composers</h2>{#each Object.entries(composers).sort((a, b) => a[0].localeCompare(b[0])).slice(0, 16) as [name, count]}{@const portrait = getComposerPortrait(name)}<button class:active={composer === name} onclick={() => { composer = name; filter = 'all'; }}><div class="portrait">{#if portrait}<img src={portrait} alt="" loading="lazy" onerror={hideBrokenImage} />{/if}<span>{initials(name)}</span></div><span>{name}</span><b>{count}</b></button>{/each}</section>{/if}
		</aside>
		<main class="main">
			<div class="toolbar"><div><h1>{currentTitle}</h1><span>{filtered.length} {filtered.length === 1 ? 'score' : 'scores'}</span></div><div class="toolbar-actions"><select class="sort-select" bind:value={sort} aria-label="Sort scores"><option value="recent">Recently used</option><option value="title">Title</option><option value="composer">Composer</option></select><div class="seg"><button class:active={view === 'grid'} onclick={() => (view = 'grid')} aria-label="Grid view"><Grid2X2 size={16} /></button><button class:active={view === 'list'} onclick={() => (view = 'list')} aria-label="List view"><List size={16} /></button></div></div></div>
			{#if !folder && !scores.length}<div class="empty"><div class="empty-icon"><FolderOpen size={30} /></div><h2>Your score library</h2><p>Choose one folder where Sonora will keep all of your scores.</p><button class="primary" onclick={chooseFolder}><FolderPlus size={17} />Choose score folder</button></div>
			{:else if filtered.length === 0}<div class="empty"><div class="empty-icon"><Search size={28} /></div><h2>No scores found</h2><p>Try another search or filter, or refresh the library.</p></div>
			{:else}<div class:score-grid={view === 'grid'} class:score-list={view === 'list'}>{#each filtered as score (score.id)}<div class="card" class:opening={openingId === score.id} role="button" tabindex="0" onclick={() => openScore(score)} onkeydown={(event) => event.key === 'Enter' && openScore(score)}><div class="cover">{#if score.thumbnailUrl}<img src={score.thumbnailUrl} alt="" loading="lazy" decoding="async" onerror={hideBrokenImage} />{:else}<div class="no-cover"><FileText size={24} /><span>{score.totalPages ? `${score.totalPages} pages` : 'Preparing preview'}</span></div>{/if}<button class="favorite" class:marked={score.favorite} onclick={(event) => toggleFavorite(score, event)} aria-label="Favorite"><Star size={15} fill={score.favorite ? 'currentColor' : 'none'} /></button><div class="card-menu"><button onclick={(event) => editMetadata(score, event)} aria-label="Edit score"><MoreHorizontal size={16} /></button><button onclick={(event) => deleteScore(score, event)} aria-label="Remove score"><X size={16} /></button></div></div><div class="info"><h3 title={score.title}>{score.title}</h3><p>{score.composer}</p>{#if score.tags?.length}<div class="tags">{#each score.tags.slice(0, 2) as tag}<span>{tag}</span>{/each}</div>{/if}</div></div>{/each}</div>{/if}
		</main>
	</div>
	{#if metadata}<div class="dialog-backdrop" role="presentation" onclick={(event) => event.currentTarget === event.target && (metadata = null)}><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="metadata-title"><header><div><h2 id="metadata-title">Edit score</h2><p>{metadata.title}</p></div><button class="icon-button" onclick={() => (metadata = null)} aria-label="Close"><X size={18} /></button></header><label>Tags<input bind:value={newTags} placeholder="Concert, piano, practice" /></label><footer><button onclick={() => (metadata = null)}>Cancel</button><button class="primary" onclick={saveMetadata}>Save</button></footer></div></div>{/if}
</div>

<style>
	.library { height:100%; display:flex; flex-direction:column; background:var(--library-bg,#11110f); color:var(--library-fg,#f5f5f4); color-scheme:dark; }
	button,input,select { font:inherit; } button { border:0; color:inherit; background:transparent; cursor:pointer; }
	.header { height:72px; display:grid; grid-template-columns:auto minmax(240px,560px) auto; align-items:center; gap:28px; padding:0 28px; border-bottom:1px solid color-mix(in srgb,currentColor 10%,transparent); }
	.brand { display:flex; align-items:center; gap:11px; font-size:1.05rem; } .brand-mark { width:36px; height:36px; display:grid; place-items:center; border-radius:11px; background:color-mix(in srgb,currentColor 9%,transparent); }
	.search { min-width:0; height:42px; display:flex; align-items:center; gap:10px; padding:0 12px; border:1px solid color-mix(in srgb,currentColor 13%,transparent); border-radius:12px; background:color-mix(in srgb,currentColor 5%,transparent); }
	.search input { flex:1; min-width:0; border:0; outline:0; background:transparent; color:inherit; } .search button { display:grid; place-items:center; opacity:.6; }
	.actions,.toolbar-actions,.seg { display:flex; align-items:center; gap:8px; } .actions { justify-content:flex-end; }
	.folder-button,.primary { min-height:40px; display:inline-flex; align-items:center; justify-content:center; gap:8px; padding:0 14px; border-radius:10px; } .folder-button { background:color-mix(in srgb,currentColor 8%,transparent); } .primary { background:currentColor; color:#11110f; font-weight:650; }
	.icon-button { width:40px; height:40px; display:grid; place-items:center; border-radius:10px; } .icon-button:hover,.seg button:hover,.seg button.active { background:color-mix(in srgb,currentColor 10%,transparent); }
	:global(.spinning svg) { animation:spin .8s linear infinite; }
	.notice { position:absolute; z-index:5; top:82px; left:50%; transform:translateX(-50%); display:flex; align-items:center; gap:8px; padding:9px 13px; border-radius:9px; background:color-mix(in srgb,#fff 12%,#11110f); box-shadow:0 8px 30px #0004; font-size:.86rem; } .notice.error { background:#522525; } .notice button { display:grid; place-items:center; }
	.body { flex:1; min-height:0; display:grid; grid-template-columns:245px minmax(0,1fr); } .sidebar { overflow:auto; padding:22px 14px; border-right:1px solid color-mix(in srgb,currentColor 9%,transparent); }
	.sidebar nav { display:flex; flex-direction:column; gap:3px; } .sidebar nav button,.sidebar section button { min-height:40px; width:100%; display:flex; align-items:center; gap:10px; padding:0 10px; border-radius:9px; text-align:left; } .sidebar button:hover,.sidebar button.active { background:color-mix(in srgb,currentColor 9%,transparent); } .sidebar b { margin-left:auto; opacity:.45; font-size:.78rem; font-weight:500; }
	.folder-summary { display:flex; gap:10px; align-items:flex-start; margin:22px 8px; padding:12px 10px; border-radius:10px; background:color-mix(in srgb,currentColor 5%,transparent); } .folder-summary div { min-width:0; display:flex; flex-direction:column; gap:2px; } .folder-summary strong { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.88rem; } .folder-summary span { opacity:.5; font-size:.76rem; }
	.sidebar section { margin-top:20px; } .sidebar h2 { margin:0 10px 7px; font-size:.72rem; text-transform:uppercase; letter-spacing:.08em; opacity:.45; font-weight:650; }
	.portrait { width:27px; height:27px; flex:none; display:grid; place-items:center; position:relative; overflow:hidden; border-radius:50%; background:color-mix(in srgb,currentColor 10%,transparent); font-size:.65rem; } .portrait img { position:absolute; inset:0; width:100%; height:100%; object-fit:cover; }
	.main { min-width:0; min-height:0; overflow:auto; padding:28px 32px 48px; } .toolbar { display:flex; align-items:flex-end; justify-content:space-between; gap:20px; margin-bottom:26px; } .toolbar h1 { margin:0; font-size:1.65rem; letter-spacing:-.025em; } .toolbar span { display:block; margin-top:4px; opacity:.48; font-size:.82rem; }
	.sort-select { height:38px; border:1px solid color-mix(in srgb,currentColor 14%,transparent); border-radius:9px; padding:0 32px 0 12px; background:#1a1a17; color:#f5f5f4; color-scheme:dark; outline:none; appearance:none; -webkit-appearance:none; background-repeat:no-repeat; background-position:right 10px center; cursor:pointer; } .sort-select option { background:#1a1a17; color:#f5f5f4; }
	.seg { padding:3px; border-radius:9px; background:color-mix(in srgb,currentColor 6%,transparent); } .seg button { width:34px; height:32px; display:grid; place-items:center; border-radius:7px; }
	.score-grid { display:grid; grid-template-columns:repeat(auto-fill,minmax(170px,1fr)); gap:24px 18px; } .card { min-width:0; cursor:pointer; } .card.opening { opacity:.7; } .card:focus-visible { outline:2px solid currentColor; outline-offset:5px; border-radius:8px; }
	.cover { position:relative; aspect-ratio:3/4; overflow:hidden; border-radius:8px; background:#f4f4f1; box-shadow:0 5px 16px #0003; }
	.cover > img { width:100%; height:100%; object-fit:contain; object-position:center; display:block; background:#fff; }
	.no-cover { width:100%; height:100%; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; opacity:.42; font-size:.78rem; }
	.favorite,.card-menu { position:absolute; top:8px; display:grid; place-items:center; width:30px; height:30px; border-radius:8px; background:#111b; backdrop-filter:blur(8px); opacity:0; pointer-events:none; transition:opacity .15s; } .favorite { right:8px; } .card-menu { left:8px; grid-template-columns:1fr 1fr; width:62px; } .cover:hover .favorite,.cover:hover .card-menu,.favorite.marked { opacity:1; pointer-events:auto; } .favorite.marked { color:#f4c95d; }
	.info { padding:10px 2px 0; } .info h3 { margin:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:.94rem; font-weight:600; } .info p { margin:4px 0 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.52; font-size:.8rem; } .tags { display:flex; gap:4px; margin-top:7px; overflow:hidden; } .tags span { padding:2px 6px; border-radius:5px; background:color-mix(in srgb,currentColor 7%,transparent); opacity:.65; font-size:.68rem; white-space:nowrap; }
	.score-list { display:flex; flex-direction:column; gap:4px; } .score-list .card { display:grid; grid-template-columns:52px minmax(0,1fr); gap:14px; align-items:center; padding:7px; border-radius:9px; } .score-list .card:hover { background:color-mix(in srgb,currentColor 6%,transparent); } .score-list .cover { width:52px; aspect-ratio:3/4; box-shadow:none; } .score-list .info { padding:0; } .score-list .favorite,.score-list .card-menu { opacity:1; transform:scale(.85); }
	.empty { min-height:420px; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; } .empty-icon { width:64px; height:64px; display:grid; place-items:center; margin-bottom:16px; border-radius:18px; background:color-mix(in srgb,currentColor 7%,transparent); opacity:.75; } .empty h2 { margin:0; font-size:1.15rem; } .empty p { max-width:380px; margin:8px 0 18px; opacity:.5; font-size:.86rem; }
	.dialog-backdrop { position:fixed; inset:0; z-index:20; display:grid; place-items:center; padding:20px; background:#0008; backdrop-filter:blur(4px); } .dialog { width:min(420px,100%); padding:20px; border:1px solid color-mix(in srgb,currentColor 12%,transparent); border-radius:14px; background:#1b1b19; box-shadow:0 24px 70px #0008; } .dialog header { display:flex; justify-content:space-between; align-items:flex-start; gap:20px; } .dialog h2 { margin:0; font-size:1.05rem; } .dialog header p { max-width:300px; margin:4px 0 0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; opacity:.5; font-size:.8rem; } .dialog label { display:flex; flex-direction:column; gap:7px; margin:22px 0; font-size:.78rem; font-weight:600; } .dialog input { height:42px; padding:0 11px; border:1px solid color-mix(in srgb,currentColor 14%,transparent); border-radius:9px; outline:0; background:#151512; color:inherit; } .dialog footer { display:flex; justify-content:flex-end; gap:8px; } .dialog footer button { min-height:40px; padding:0 13px; border-radius:9px; }
	@keyframes spin { to { transform:rotate(360deg); } }
	@media (max-width:850px) { .header { grid-template-columns:auto minmax(0,1fr) auto; gap:12px; padding:0 16px; } .folder-button span { display:none; } .body { grid-template-columns:190px minmax(0,1fr); } .main { padding:22px 20px 40px; } }
	@media (max-width:650px) { .header { height:64px; } .brand strong { display:none; } .body { display:block; } .sidebar { display:none; } .main { padding:18px 14px 32px; } .toolbar { align-items:center; margin-bottom:20px; } .toolbar-actions .sort-select { display:none; } .score-grid { grid-template-columns:repeat(2,minmax(0,1fr)); gap:20px 12px; } }
	@media (prefers-reduced-motion:reduce) { :global(.spinning svg) { animation:none; } }
</style>
