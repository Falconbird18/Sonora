<script lang="ts">
	import { Download, ExternalLink, Loader2, Search, X } from '@lucide/svelte';
	import {
		downloadScore,
		getWorkScores,
		imslpAvailable,
		parseWorkTitle,
		searchImslp,
		workPageUrl,
		type ImslpScoreFile,
		type ImslpSearchHit
	} from '../imslp';
	import SearchField from './SearchField.svelte';
	import TextButton from './TextButton.svelte';
	import IconButton from './IconButton.svelte';

	let {
		open = $bindable(false),
		libraryRoot = null as string | null,
		onDownloaded
	}: {
		open?: boolean;
		libraryRoot?: string | null;
		onDownloaded?: (info: { filename: string; relativePath?: string | null }) => void;
	} = $props();

	let query = $state('');
	let searching = $state(false);
	let hits = $state<ImslpSearchHit[]>([]);
	let error = $state('');
	let selected = $state<ImslpSearchHit | null>(null);
	let scores = $state<ImslpScoreFile[]>([]);
	let loadingScores = $state(false);
	let downloading = $state<string | null>(null);
	let notice = $state('');

	const available = imslpAvailable();

	async function runSearch() {
		error = '';
		notice = '';
		selected = null;
		scores = [];
		if (!query.trim()) {
			hits = [];
			return;
		}
		searching = true;
		try {
			hits = await searchImslp(query, 25);
			if (!hits.length) notice = 'No works matched that search.';
		} catch (e) {
			error = e instanceof Error ? e.message : 'Search failed';
			hits = [];
		} finally {
			searching = false;
		}
	}

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void runSearch();
		}
	}

	async function selectWork(hit: ImslpSearchHit) {
		selected = hit;
		scores = [];
		error = '';
		notice = '';
		loadingScores = true;
		try {
			scores = await getWorkScores(hit.title);
			if (!scores.length) {
				notice =
					'No PDF scores were found on this work page. You can still open it on IMSLP.';
			}
		} catch (e) {
			error = e instanceof Error ? e.message : 'Could not load scores for this work';
		} finally {
			loadingScores = false;
		}
	}

	async function doDownload(score: ImslpScoreFile) {
		error = '';
		notice = '';
		downloading = score.filename;
		try {
			const result = await downloadScore(score.filename, libraryRoot);
			notice = result.saved_path
				? `Saved “${result.filename}” into your library (IMSLP folder).`
				: `Downloaded “${result.filename}” (${Math.round(result.size / 1024)} KB).`;
			onDownloaded?.({
				filename: result.filename,
				relativePath: result.relative_path
			});
		} catch (e) {
			error = e instanceof Error ? e.message : 'Download failed';
		} finally {
			downloading = null;
		}
	}

	function close() {
		open = false;
	}

	function backToResults() {
		selected = null;
		scores = [];
		error = '';
		notice = '';
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={close} role="presentation"></div>
	<div
		class="panel"
		role="dialog"
		aria-modal="true"
		aria-labelledby="imslp-title"
		tabindex="-1">
		<header class="head">
			<div>
				<h2 id="imslp-title">Search IMSLP</h2>
				<p class="sub">Public-domain scores via IMSLP’s public API</p>
			</div>
			<IconButton title="Close" ariaLabel="Close IMSLP search" onclick={close}>
				<X size={18} />
			</IconButton>
		</header>

		{#if !available}
			<div class="message">
				<p>
					IMSLP search and download are available in the <strong>desktop app</strong> so
					requests can go through native networking (browsers block cross-origin access to
					IMSLP).
				</p>
			</div>
		{:else}
			<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
			<div class="search-row" onkeydown={onSearchKeydown}>
				<SearchField
					bind:value={query}
					placeholder="Composer, work, opus…"
					ariaLabel="Search IMSLP" />
				<TextButton onclick={() => void runSearch()} disabled={searching || !query.trim()}>
					{#if searching}
						<Loader2 size={16} class="spin" />
					{:else}
						<Search size={16} />
					{/if}
					<span>Search</span>
				</TextButton>
			</div>

			{#if error}
				<p class="err">{error}</p>
			{/if}
			{#if notice}
				<p class="ok">{notice}</p>
			{/if}

			{#if selected}
				<div class="work-head">
					<button type="button" class="linkish" onclick={backToResults}>← Results</button>
					<h3>{selected.title}</h3>
					<a
						class="external"
						href={workPageUrl(selected.title)}
						target="_blank"
						rel="noopener noreferrer">
						Open on IMSLP <ExternalLink size={14} />
					</a>
				</div>

				{#if loadingScores}
					<div class="message muted"><Loader2 size={18} class="spin" /> Loading scores…</div>
				{:else if scores.length}
					<ul class="score-list">
						{#each scores as score (score.filename)}
							<li>
								<div class="meta">
									<strong>{score.filename}</strong>
									{#if score.description}
										<span>{score.description}</span>
									{/if}
									{#if score.editor}
										<span class="editor">Editor: {score.editor}</span>
									{/if}
								</div>
								<button
									type="button"
									class="dl"
									disabled={!!downloading}
									onclick={() => void doDownload(score)}>
									{#if downloading === score.filename}
										<Loader2 size={16} class="spin" />
									{:else}
										<Download size={16} />
									{/if}
									<span>Add to library</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			{:else if hits.length}
				<ul class="hits">
					{#each hits as hit (hit.title)}
						{@const parsed = parseWorkTitle(hit.title)}
						<li>
							<button type="button" class="hit" onclick={() => void selectWork(hit)}>
								<strong>{parsed.title}</strong>
								<span class="composer">{parsed.composer}</span>
								{#if hit.snippet}
									<span class="snippet">{hit.snippet}</span>
								{/if}
							</button>
						</li>
					{/each}
				</ul>
			{:else if !searching && !query.trim()}
				<div class="message muted">
					Search for a composer or work (e.g. “Moonlight Sonata”, “Bach cello suite”).
				</div>
			{/if}
		{/if}
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		background: rgba(0, 0, 0, 0.45);
		z-index: 80;
	}
	.panel {
		position: fixed;
		top: 50%;
		left: 50%;
		transform: translate(-50%, -50%);
		width: min(560px, calc(100vw - 32px));
		max-height: min(80vh, 720px);
		display: flex;
		flex-direction: column;
		gap: 12px;
		padding: 18px 18px 16px;
		border-radius: 16px;
		background: var(--surface-elevated, #1c1c1e);
		color: var(--text, #f5f5f7);
		box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
		z-index: 81;
		overflow: hidden;
	}
	.head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
	}
	.head h2 {
		margin: 0;
		font-size: 1.15rem;
		font-weight: 650;
	}
	.sub {
		margin: 2px 0 0;
		font-size: 0.8rem;
		opacity: 0.65;
	}
	.search-row {
		display: flex;
		gap: 8px;
		align-items: center;
	}
	.search-row :global(.search-field) {
		flex: 1;
	}
	.message {
		padding: 16px 4px;
		line-height: 1.45;
		font-size: 0.92rem;
	}
	.message.muted {
		opacity: 0.7;
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.err {
		margin: 0;
		color: #ff6b6b;
		font-size: 0.85rem;
	}
	.ok {
		margin: 0;
		color: #6bcb77;
		font-size: 0.85rem;
	}
	.hits,
	.score-list {
		list-style: none;
		margin: 0;
		padding: 0;
		overflow-y: auto;
		flex: 1;
		min-height: 0;
	}
	.hit {
		width: 100%;
		text-align: left;
		border: 0;
		background: transparent;
		color: inherit;
		padding: 10px 8px;
		border-radius: 10px;
		cursor: pointer;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.hit:hover {
		background: rgba(255, 255, 255, 0.06);
	}
	.hit strong {
		font-size: 0.95rem;
	}
	.composer {
		font-size: 0.82rem;
		opacity: 0.75;
	}
	.snippet {
		font-size: 0.75rem;
		opacity: 0.55;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.work-head {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.work-head h3 {
		margin: 0;
		font-size: 1rem;
	}
	.linkish {
		border: 0;
		background: none;
		color: var(--accent, #7aa2ff);
		padding: 0;
		cursor: pointer;
		font-size: 0.82rem;
		width: fit-content;
	}
	.external {
		display: inline-flex;
		align-items: center;
		gap: 4px;
		font-size: 0.8rem;
		color: var(--accent, #7aa2ff);
		text-decoration: none;
	}
	.score-list li {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 10px 4px;
		border-bottom: 1px solid rgba(255, 255, 255, 0.06);
	}
	.meta {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.meta strong {
		font-size: 0.85rem;
		word-break: break-all;
	}
	.meta span {
		font-size: 0.78rem;
		opacity: 0.7;
	}
	.editor {
		opacity: 0.55 !important;
	}
	.dl {
		flex-shrink: 0;
		display: inline-flex;
		align-items: center;
		gap: 6px;
		border: 0;
		border-radius: 8px;
		padding: 8px 12px;
		background: var(--accent, #3d6cf5);
		color: #fff;
		font-size: 0.8rem;
		cursor: pointer;
	}
	.dl:disabled {
		opacity: 0.6;
		cursor: default;
	}
	:global(.spin) {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
