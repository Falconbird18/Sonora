<script lang="ts">
	import {
		Download,
		ExternalLink,
		Globe,
		Loader2,
		Music2,
		Search,
		X
	} from '@lucide/svelte';
	import IconButton from './IconButton.svelte';
	import TextButton from './TextButton.svelte';
	import {
		displayFilename,
		downloadScore,
		getWorkScores,
		imslpAvailable,
		parseWorkTitle,
		searchImslp,
		workPageUrl,
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
			hits = await searchImslp(query, 30);
			if (!hits.length) notice = 'No works matched that search.';
		} catch (e) {
			error =
				e instanceof Error
					? e.message
					: typeof e === 'string'
						? e
						: 'Search failed';
			console.error('[IMSLP] search failed', e);
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
			error =
				e instanceof Error
					? e.message
					: typeof e === 'string'
						? e
						: 'Failed to load scores for this work';
			console.error('[IMSLP] load scores failed', e);
		} finally {
			loadingScores = false;
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
				workTitle: selected?.title ?? null
			});
			const where = parsed?.composer
				? `under “${parsed.composer}”`
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
		open = false;
	}

	function backToResults() {
		selected = null;
		scores = [];
		error = '';
		notice = '';
	}

	function onPanelKeydown(event: KeyboardEvent) {
		if (event.key === 'Escape') {
			event.preventDefault();
			if (selected) backToResults();
			else close();
		}
	}

	function snippetFor(hit: ImslpSearchHit) {
		let s = (hit.snippet || '')
			.replace(/</gi, '<')
			.replace(/>/gi, '>')
			.replace(/"/gi, '"')
			.replace(/&#39;/g, "'")
			.replace(/&nbsp;/gi, ' ')
			.replace(/&/gi, '&');
		s = s.replace(/<[^>]+>/g, ' ');
		s = s
			.replace(/\{\{[^}]*\}\}/g, ' ')
			.replace(/\[\[[^\]]*\]\]/g, ' ')
			.replace(/\|[^|=\s]+=/g, ' ')
			.replace(/'{2,}/g, '')
			.replace(/[|{}]/g, ' ')
			.replace(/\s+/g, ' ')
			.replace(/^[\s.·]+/, '')
			.trim();
		return s;
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div class="backdrop" onclick={close} role="presentation"></div>

	<div
		class="panel"
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
						aria-label="Search IMSLP"
						autofocus />
				</div>
				<TextButton
					variant="primary"
					onclick={() => void runSearch()}
					disabled={searching || !query.trim()}>
					{#if searching}<Loader2 size={16} class="spin" /> Searching…{:else}Search{/if}
				</TextButton>
			</div>
		{/if}

		{#if error}<div class="banner error">{error}</div>{/if}
		{#if notice}<div class="banner ok">{notice}</div>{/if}

		<div class="body" class:split={!!selected}>
			{#if selected}
				<aside class="context">
					<button type="button" class="back" onclick={backToResults}
						>← All results</button>
					{#if true}
						{@const parsed = parseWorkTitle(selected.title)}
						<h2>{parsed.title}</h2>
						<p class="composer">{parsed.composer}</p>
						{#if snippetFor(selected)}<p class="snippet">
								{snippetFor(selected)}
							</p>{/if}
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
						<h3>Available PDFs</h3>
						<span
							>{scores.length} {scores.length === 1 ? 'file' : 'files'}</span>
					</div>
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
					{:else}
						<div class="score-grid">
							{#each scores as score (score.filename)}
								<article class="score-card">
									<div class="thumb">
										{#if score.thumb_url}
											<img
												src={score.thumb_url}
												alt=""
												loading="lazy"
												referrerpolicy="no-referrer"
												onerror={(e) => {
													const el = e.currentTarget as HTMLImageElement;
													el.style.display = 'none';
													const fb = el.parentElement?.querySelector('.thumb-fallback');
													if (fb instanceof HTMLElement) fb.style.display = 'grid';
												}} />
											<div class="thumb-fallback" style="display:none"
												><Music2 size={28} /></div>
										{:else}
											<div class="thumb-fallback"><Music2 size={28} /></div>
										{/if}
									</div>
									<div class="score-meta">
										<strong title={score.filename}
											>{displayFilename(score.filename)}</strong>
										{#if score.description}<span class="desc"
												>{score.description}</span
											>{/if}
										{#if score.editor}<span class="editor"
												>{score.editor}</span
											>{/if}
									</div>
									<button
										type="button"
										class="add-btn"
										class:added={added.has(score.filename)}
										disabled={downloading === score.filename || !libraryRoot || added.has(score.filename)}
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
										{#if hit.thumb_url}
											<img src={hit.thumb_url} alt="" loading="lazy" referrerpolicy="no-referrer"
												onerror={(e) => { /* hide + show Music2 fallback */ }} />
										{:else}
											<Music2 size={18} />
										{/if}
									</div>
									<div class="hit-body">
										<strong>{parsed.title}</strong>
										<span class="composer">{parsed.composer}</span>
										{#if snippetFor(hit)}<span class="snippet"
												>{snippetFor(hit)}</span
											>{/if}
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
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 80;
		background: rgba(8, 10, 14, 0.62);
		backdrop-filter: blur(6px);
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
		border-radius: 18px;
		background: var(--sonora-bg-elevated);
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
		background: color-mix(in srgb, var(--sonora-bg-workspace) 70%, transparent);
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
		border-radius: 11px;
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
		font-size: 12px;
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
		border-radius: 12px;
		background: var(--sonora-bg-workspace);
		color: var(--sonora-text);
		font-size: 14px;
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
		border-radius: 10px;
		font-size: 13px;
		line-height: 1.4;
	}
	.banner.error {
		background: color-mix(in srgb, #ff5c5c 14%, transparent);
		color: #ffb4b4;
		border: 1px solid color-mix(in srgb, #ff5c5c 35%, transparent);
	}
	.banner.ok {
		background: color-mix(in srgb, #3ecf8e 12%, transparent);
		color: #b6f0d2;
		border: 1px solid color-mix(in srgb, #3ecf8e 30%, transparent);
	}
	.banner.warn {
		background: color-mix(in srgb, #f0c14b 12%, transparent);
		color: #f5e0a0;
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
		background: color-mix(in srgb, var(--sonora-bg-workspace) 55%, transparent);
	}
	.back {
		border: 0;
		background: transparent;
		color: var(--sonora-accent);
		font-size: 13px;
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
		font-size: 13px;
	}
	.snippet {
		margin: 10px 0 0;
		font-size: 12.5px;
		line-height: 1.45;
		color: var(--sonora-text-muted);
	}
	.external {
		display: inline-flex;
		align-items: center;
		gap: 6px;
		margin-top: 14px;
		font-size: 13px;
		color: var(--sonora-accent);
		text-decoration: none;
	}
	.external:hover {
		text-decoration: underline;
	}
	.hint {
		margin-top: 16px;
		font-size: 12px;
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
		font-size: 13px;
		font-weight: 650;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--sonora-text-faint);
	}
	.results-head span,
	.scores-head span {
		font-size: 12px;
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
		border-radius: 12px;
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
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border-radius: 10px;
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
		font-size: 14px;
		font-weight: 650;
	}
	.hit-body .composer {
		font-size: 12.5px;
	}
	.hit-body .snippet {
		margin: 4px 0 0;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
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
		border-radius: 14px;
		background: color-mix(in srgb, var(--sonora-bg-workspace) 65%, transparent);
	}
	.thumb {
		aspect-ratio: 3 / 4;
		border-radius: 10px;
		overflow: hidden;
		background: var(--sonora-bg-active);
		border: 1px solid var(--sonora-border);
	}
	.thumb img {
		width: 100%;
		height: 100%;
		object-fit: cover;
		object-position: top center;
		display: block;
	}
	.thumb-fallback {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		color: var(--sonora-text-faint);
	}
	.score-meta {
		display: flex;
		flex-direction: column;
		gap: 4px;
		min-height: 56px;
	}
	.score-meta strong {
		font-size: 13px;
		font-weight: 650;
		line-height: 1.3;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.desc,
	.editor {
		font-size: 12px;
		color: var(--sonora-text-muted);
		line-height: 1.35;
		display: -webkit-box;
		-webkit-line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}
	.editor {
		color: var(--sonora-text-faint);
	}
	.add-btn.added {
		background: color-mix(in srgb, #3ecf8e 18%, transparent);
		color: #b6f0d2;
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
		border-radius: 10px;
		background: var(--sonora-accent);
		color: #fff;
		font-size: 12.5px;
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
		font-size: 13px;
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
