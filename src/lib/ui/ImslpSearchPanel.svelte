<script lang="ts">
	import { dialogFocus } from './dialogFocus';
	import {
		Download,
		ExternalLink,
		Globe,
		Loader2,
		Music2,
		Search,
		X
	} from '@lucide/svelte';
	import ImslpThumbnail from './ImslpThumbnail.svelte';
	import { settings } from '../settingsStore';
	import { formatComposer } from '../composerDisplay';
	import IconButton from './IconButton.svelte';
	import TextButton from './TextButton.svelte';
	import {
		downloadScore,
		getWorkScores,
		imslpAvailable,
		parseWorkTitle,
		searchImslp,
		workPageUrl,
		type ImslpWorkDetails,
		type ImslpScoreFile,
		type ImslpSearchHit
	} from '../imslp';

	let {
		open = $bindable(false),
		libraryRoot = null as string | null,
		onDownloaded
	}: {
		open?: boolean;
		libraryRoot?: string | null;
		onDownloaded?: (info: {
			filename: string;
			relativePath?: string | null;
		}) => void;
	} = $props();

	let query = $state('');
	let searching = $state(false);
	let hits = $state<ImslpSearchHit[]>([]);
	let error = $state('');
	let selected = $state<ImslpSearchHit | null>(null);
	let scores = $state<ImslpScoreFile[]>([]);
	let loadingScores = $state(false);
	let downloading = $state<string | null>(null);
	let added = $state<Set<string>>(new Set());
	let notice = $state('');
	let details = $state<ImslpWorkDetails | null>(null);
	let request = 0;
	let editionFilter = $state('');
	const visibleScores = $derived(
		scores.filter((s) =>
			`${s.description} ${s.publisher} ${s.editor} ${s.arranger} ${s.section}`
				.toLowerCase()
				.includes(editionFilter.toLowerCase())
		)
	);

	const available = imslpAvailable();

	async function runSearch() {
		const current = ++request;
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
			const results = await searchImslp(query, 30);
			if (current !== request) return;
			hits = results;
			if (!hits.length) notice = 'No works matched that search.';
		} catch (e) {
			if (current !== request) return;
			error =
				e instanceof Error
					? e.message
					: typeof e === 'string'
						? e
						: 'Search failed';
			console.error('[IMSLP] search failed', e);
		} finally {
			if (current === request) searching = false;
		}
	}

	function onSearchKeydown(event: KeyboardEvent) {
		if (event.key === 'Enter') {
			event.preventDefault();
			void runSearch();
		}
	}

	async function selectWork(hit: ImslpSearchHit) {
		const current = ++request;
		selected = hit;
		details = null;
		editionFilter = '';
		scores = [];
		error = '';
		notice = '';
		loadingScores = true;
		try {
			const result = await getWorkScores(hit.title);
			if (current !== request) return;
			details = result;
			scores = result.files;
			if (!scores.length) {
				notice =
					'No PDF scores were found on this work page. You can still open it on IMSLP.';
			}
		} catch (e) {
			if (current !== request) return;
			error =
				e instanceof Error
					? e.message
					: typeof e === 'string'
						? e
						: 'Failed to load scores for this work';
			console.error('[IMSLP] load scores failed', e);
		} finally {
			if (current === request) loadingScores = false;
		}
	}

	async function doDownload(score: ImslpScoreFile) {
		error = '';
		notice = '';
		downloading = score.filename;
		try {
			const parsed = selected ? parseWorkTitle(selected.title) : null;
			const result = await downloadScore(score.filename, {
				libraryRoot,
				composer: parsed?.composer ?? null,
				workTitle: parsed?.title ?? null,
				metadata: {
					...details?.metadata,
					year: /^\d{4}$/.test(details?.metadata.compositionDate ?? '')
						? Number(details?.metadata.compositionDate)
						: undefined,
					title: parsed?.title,
					composer: parsed?.composer,
					workId: selected ? `imslp:${selected.title}` : undefined,
					workTitle: parsed?.title,
					imslpPage: selected?.title,
					edition: score.description,
					editor: score.editor,
					publisher: score.publisher,
					arranger: score.arranger
				}
			});
			const where = parsed?.composer
				? `under “${formatComposer(parsed.composer, $settings.composerDisplay)}”`
				: 'into your library';
			notice = result.saved_path
				? `Saved “${result.filename}” ${where}.`
				: `Downloaded “${result.filename}” (${Math.round(result.size / 1024)} KB).`;
			added = new Set(added).add(score.filename);
			onDownloaded?.({
				filename: result.filename,
				relativePath: result.relative_path
			});
		} catch (e) {
			error =
				e instanceof Error
					? e.message
					: typeof e === 'string'
						? e
						: 'Download failed';
			console.error('[IMSLP] download failed', e);
		} finally {
			downloading = null;
		}
	}

	function close() {
		++request;
		searching = false;
		loadingScores = false;
		open = false;
	}

	function backToResults() {
		++request;
		loadingScores = false;
		selected = null;
		scores = [];
		error = '';
		notice = '';
	}

	function onPanelKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			event.stopPropagation();
			if (selected) backToResults();
			else close();
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={close} role="presentation"></div>

	<div
		class="panel"
		use:dialogFocus
		role="dialog"
		aria-modal="true"
		aria-label="Search IMSLP"
		tabindex="-1"
		onkeydown={onPanelKeydown}>
		<header class="panel-header">
			<div class="title-block">
				<div class="mark"><Globe size={18} /></div>
				<div>
					<strong>IMSLP</strong>
					<span>Search public-domain scores and add them to your library</span>
				</div>
			</div>
			<IconButton title="Close" ariaLabel="Close IMSLP search" onclick={close}>
				<X size={18} />
			</IconButton>
		</header>

		{#if !available}
			<div class="banner warn">
				IMSLP search and download are available in the Sonora desktop app.
			</div>
		{:else}
			<div class="search-row">
				<div class="search-field">
					<Search size={16} class="search-icon" />
					<input
						type="search"
						placeholder="Search works or composers — e.g. Moonlight Sonata, Bach cello"
						bind:value={query}
						onkeydown={onSearchKeydown}
						aria-label="Search IMSLP" />
				</div>
				<TextButton
					onclick={() => void runSearch()}
					disabled={searching || !query.trim()}>
					{#if searching}<Loader2 size={16} class="spin" /> Searching…{:else}Search{/if}
				</TextButton>
			</div>
		{/if}

		{#if error}<div class="banner error" role="alert">{error}</div>{/if}
		{#if notice}<div class="banner ok" role="status">{notice}</div>{/if}

		<div class="body" class:split={!!selected}>
			{#if selected}
				<aside class="context">
					<button type="button" class="back" onclick={backToResults}
						>← All results</button>
					{#if true}
						{@const parsed = parseWorkTitle(selected.title)}
						<h2>{parsed.title}</h2>
						<p class="composer">
							{formatComposer(parsed.composer, $settings.composerDisplay)}
						</p>
						{#if details}
							<dl class="work-facts">
								{#each Object.entries(details.metadata).filter(([key, value]) => key !== 'title' && value) as [key, value]}
									<dt>
										{(
											{
												catalogue: 'Catalogue',
												key: 'Key',
												instruments: 'Instruments',
												compositionDate: 'Composed',
												movements: 'Movements',
												period: 'Style'
											} as Record<string, string>
										)[key] ?? key}
									</dt>
									<dd>{value}</dd>
								{/each}
							</dl>
						{/if}
						<a
							class="external"
							href={workPageUrl(selected.title)}
							target="_blank"
							rel="noopener noreferrer">
							Open on IMSLP <ExternalLink size={14} />
						</a>
						{#if !libraryRoot}
							<p class="hint">
								Choose a score folder in the library first so downloads can be
								saved.
							</p>
						{/if}
					{/if}
				</aside>
				<section class="scores">
					<div class="scores-head">
						<h3>Compare editions & parts</h3>
						<span
							>{editionFilter
								? `${visibleScores.length} of ${scores.length} files`
								: `${scores.length} ${scores.length === 1 ? 'file' : 'files'}`}</span>
					</div>
					<input
						class="edition-search"
						aria-label="Filter editions and parts"
						placeholder="Filter by publisher, editor, part…"
						bind:value={editionFilter} />
					{#if loadingScores}
						<div class="empty-state">
							<Loader2 size={22} class="spin" />
							<p>Loading scores…</p>
						</div>
					{:else if !scores.length}
						<div class="empty-state">
							<Music2 size={22} />
							<p>No PDF scores found on this page.</p>
						</div>
					{:else if !visibleScores.length}
						<div class="empty-state">
							<p>No editions match this filter.</p>
							<TextButton onclick={() => (editionFilter = '')}
								>Clear filter</TextButton>
						</div>
					{:else}
						<div class="score-grid">
							{#each visibleScores as score (score.filename)}
								<article class="score-card">
									<div class="thumb">
										<ImslpThumbnail
											url={score.thumb_url}
											label={score.description || 'Score preview'} />
									</div>
									<div class="score-meta">
										<strong title={score.filename}
											>{score.description || 'Score edition'}</strong>
										{#if score.publisher}<span class="desc"
												>{score.publisher}</span
											>{/if}
										{#if score.arranger}<span class="editor"
												>Arranged by {score.arranger}</span
											>{/if}
										{#if score.section}<span class="desc">{score.section}</span
											>{/if}
										{#if score.copyright}<span class="editor"
												>{score.copyright}</span
											>{/if}
										{#if score.editor}<span class="editor">{score.editor}</span
											>{/if}
									</div>
									<button
										type="button"
										class="add-btn"
										class:added={added.has(score.filename)}
										disabled={downloading !== null ||
											!libraryRoot ||
											added.has(score.filename)}
										onclick={() => void doDownload(score)}>
										{#if downloading === score.filename}
											<Loader2 size={15} class="spin" /> Saving…
										{:else if added.has(score.filename)}
											Added
										{:else}
											<Download size={15} /> Add to library
										{/if}
									</button>
								</article>
							{/each}
						</div>
					{/if}
				</section>
			{:else}
				<section class="results">
					{#if searching}
						<div class="empty-state">
							<Loader2 size={22} class="spin" />
							<p>Searching IMSLP…</p>
						</div>
					{:else if !hits.length}
						<div class="empty-state hero">
							<div class="hero-orb" aria-hidden="true"></div>
							<h2>Browse IMSLP inside Sonora</h2>
							<p>
								Search for a work or composer, pick an edition, and save the PDF
								into your library folder.
							</p>
						</div>
					{:else}
						<div class="results-head">
							<h3>Works</h3>
							<span>{hits.length} results</span>
						</div>
						<div class="hit-list">
							{#each hits as hit (hit.title)}
								{@const parsed = parseWorkTitle(hit.title)}
								<button
									type="button"
									class="hit"
									onclick={() => void selectWork(hit)}>
									<div class="hit-icon">
										<ImslpThumbnail url={hit.thumb_url} label="Work preview" />
									</div>
									<div class="hit-body">
										<strong>{parsed.title}</strong>
										<span class="composer"
											>{formatComposer(
												parsed.composer,
												$settings.composerDisplay
											)}</span>
									</div>
								</button>
							{/each}
						</div>
					{/if}
				</section>
			{/if}
		</div>
	</div>
{/if}

<style>
	.work-facts {
		font-size: var(--sonora-text-sm);
		line-height: 1.6;
	}
	.work-facts dt {
		color: var(--sonora-text-muted);
		margin-top: 12px;
	}
	.work-facts dd {
		margin: 0;
		white-space: pre-line;
	}
	.edition-search {
		width: 100%;
		box-sizing: border-box;
		padding: 10px;
		margin: 0 0 16px;
		background: var(--sonora-bg-deep);
		color: var(--sonora-text);
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-sm);
	}

	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		background: var(--sonora-scrim);
		backdrop-filter: var(--sonora-blur);
		-webkit-backdrop-filter: var(--sonora-blur);
	}
	.panel {
		position: fixed;
		z-index: 90;
		top: 3vh;
		left: 50%;
		transform: translateX(-50%);
		width: min(1180px, calc(100vw - 32px));
		height: min(92vh, 900px);
		display: flex;
		flex-direction: column;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-lg);
		background: var(--sonora-surface-raised);
		box-shadow:
			var(--sonora-shadow-lg),
			0 24px 80px rgba(0, 0, 0, 0.35);
		overflow: hidden;
		color: var(--sonora-text);
	}
	.panel-header {
		flex: 0 0 auto;
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 16px 20px;
		border-bottom: 1px solid var(--sonora-border);
		background: var(--sonora-surface-raised);
	}
	.title-block {
		display: flex;
		align-items: center;
		gap: 12px;
		min-width: 0;
	}
	.mark {
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-accent-soft);
		color: var(--sonora-accent);
		flex: 0 0 auto;
	}
	.title-block strong {
		display: block;
		font-size: 15px;
		font-weight: 700;
	}
	.title-block span {
		display: block;
		font-size: var(--sonora-text-sm);
		color: var(--sonora-text-muted);
	}
	.search-row {
		flex: 0 0 auto;
		display: flex;
		gap: 10px;
		padding: 14px 20px 0;
	}
	.search-field {
		flex: 1;
		min-width: 0;
		position: relative;
		display: flex;
		align-items: center;
	}
	.search-field :global(.search-icon) {
		position: absolute;
		left: 12px;
		color: var(--sonora-text-muted);
		pointer-events: none;
	}
	.search-field input {
		width: 100%;
		height: 42px;
		padding: 0 14px 0 38px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-bg-workspace);
		color: var(--sonora-text);
		font-size: var(--sonora-text-md);
	}
	.search-field input:focus {
		outline: none;
		border-color: color-mix(
			in srgb,
			var(--sonora-accent) 55%,
			var(--sonora-border-strong)
		);
		box-shadow: 0 0 0 3px var(--sonora-accent-soft);
	}
	.banner {
		margin: 12px 20px 0;
		padding: 10px 12px;
		border-radius: var(--sonora-radius-md);
		font-size: var(--sonora-text-md);
		line-height: 1.4;
	}
	.banner.error {
		background: color-mix(in srgb, #ff5c5c 14%, transparent);
		color: var(--sonora-danger);
		border: 1px solid color-mix(in srgb, #ff5c5c 35%, transparent);
	}
	.banner.ok {
		background: color-mix(in srgb, #3ecf8e 12%, transparent);
		color: var(--sonora-success);
		border: 1px solid color-mix(in srgb, #3ecf8e 30%, transparent);
	}
	.banner.warn {
		background: color-mix(in srgb, #f0c14b 12%, transparent);
		color: var(--sonora-warning);
		border: 1px solid color-mix(in srgb, #f0c14b 30%, transparent);
	}
	.body {
		flex: 1;
		min-height: 0;
		display: grid;
		grid-template-columns: 1fr;
		margin-top: 12px;
	}
	.body.split {
		grid-template-columns: minmax(240px, 300px) minmax(0, 1fr);
	}
	.context {
		overflow-y: auto;
		padding: 8px 18px 20px 20px;
		border-right: 1px solid var(--sonora-border);
		background: var(--sonora-surface-raised);
	}
	.back {
		border: 0;
		background: transparent;
		color: var(--sonora-accent);
		font-size: var(--sonora-text-md);
		font-weight: 600;
		padding: 0;
		margin-bottom: 12px;
		cursor: pointer;
	}
	.context h2 {
		margin: 0 0 6px;
		font-size: 18px;
		font-weight: 700;
		line-height: 1.25;
	}
	.composer {
		color: var(--sonora-text-muted);
		font-size: var(--sonora-text-md);
	}
	.external {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 14px;
		font-size: var(--sonora-text-md);
		color: var(--sonora-accent);
		text-decoration: none;
	}
	.external:hover {
		text-decoration: underline;
	}
	.hint {
		margin-top: 16px;
		font-size: var(--sonora-text-sm);
		line-height: 1.4;
		color: var(--sonora-text-faint);
	}
	.results,
	.scores {
		min-width: 0;
		overflow-y: auto;
		padding: 4px 20px 24px;
	}
	.results-head,
	.scores-head {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
		gap: 12px;
		margin-bottom: 12px;
	}
	.results-head h3,
	.scores-head h3 {
		margin: 0;
		font-size: var(--sonora-text-md);
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--sonora-text-faint);
	}
	.results-head span,
	.scores-head span {
		font-size: var(--sonora-text-sm);
		color: var(--sonora-text-muted);
	}
	.hit-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}
	.hit {
		display: flex;
		gap: 12px;
		align-items: flex-start;
		width: 100%;
		padding: 12px;
		border: 1px solid transparent;
		border-radius: var(--sonora-radius-md);
		background: transparent;
		color: inherit;
		text-align: left;
		cursor: pointer;
	}
	.hit:hover {
		background: var(--sonora-bg-hover);
		border-color: var(--sonora-border);
	}
	.hit-icon {
		width: 52px;
		height: 68px;
		display: grid;
		place-items: center;
		overflow: hidden;
		border-radius: var(--sonora-radius-sm);
		background: var(--sonora-bg-active);
		color: var(--sonora-text-muted);
		flex: 0 0 auto;
	}
	.hit-body {
		min-width: 0;
		display: flex;
		flex-direction: column;
		gap: 2px;
	}
	.hit-body strong {
		font-size: var(--sonora-text-md);
		font-weight: 650;
	}
	.hit-body .composer {
		font-size: var(--sonora-text-sm);
	}
	.score-grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
		gap: 14px;
	}
	.score-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 12px;
		border: 1px solid var(--sonora-border);
		border-radius: var(--sonora-radius-lg);
		background: var(--sonora-surface-raised);
	}
	.thumb {
		aspect-ratio: 3 / 4;
		border-radius: var(--sonora-radius-md);
		overflow: hidden;
		background: var(--sonora-bg-active);
		border: 1px solid var(--sonora-border);
	}
	.score-meta {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-height: 56px;
	}
	.score-meta strong {
		font-size: var(--sonora-text-md);
		font-weight: 650;
		line-height: 1.3;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.desc,
	.editor {
		font-size: var(--sonora-text-sm);
		color: var(--sonora-text-muted);
		line-height: 1.35;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.editor {
		color: var(--sonora-text-faint);
	}
	.add-btn.added {
		background: color-mix(in srgb, #3ecf8e 18%, transparent);
		color: var(--sonora-success);
		border-color: color-mix(in srgb, #3ecf8e 40%, transparent);
		cursor: default;
	}
	.add-btn {
		height: 34px;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 6px;
		width: 100%;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
		font-size: var(--sonora-text-sm);
		font-weight: 650;
		cursor: pointer;
	}
	.add-btn:disabled:not(.added) {
		opacity: 0.55;
		cursor: not-allowed;
	}
	.add-btn:not(:disabled):hover {
		filter: brightness(1.06);
	}
	.empty-state {
		display: grid;
		place-items: center;
		gap: 10px;
		padding: 48px 16px;
		color: var(--sonora-text-muted);
		text-align: center;
	}
	.empty-state.hero {
		padding: 64px 24px;
	}
	.hero-orb {
		width: 64px;
		height: 64px;
		border-radius: 50%;
		background: radial-gradient(
			circle at 30% 30%,
			var(--sonora-accent-soft),
			transparent 70%
		);
		margin-bottom: 8px;
	}
	.empty-state h2 {
		margin: 0;
		font-size: 18px;
		color: var(--sonora-text);
	}
	.empty-state p {
		margin: 0;
		max-width: 360px;
		font-size: var(--sonora-text-md);
		line-height: 1.45;
	}
	:global(.spin) {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (min-width: 721px) and (max-width: 900px) {
		.body.split {
			grid-template-columns: 220px minmax(0, 1fr);
		}
		.score-grid {
			grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
		}
	}
	@media (max-width: 720px) {
		.panel {
			top: 0;
			left: 0;
			transform: none;
			width: 100vw;
			height: 100vh;
			border-radius: 0;
		}
		.body.split {
			grid-template-columns: 1fr;
		}
		.context {
			border-right: 0;
			border-bottom: 1px solid var(--sonora-border);
			max-height: 28vh;
		}
	}
</style>
