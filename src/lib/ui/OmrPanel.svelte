<script lang="ts">
	import { onMount } from 'svelte';
	import ViewerPanel from './ViewerPanel.svelte';
	import type { ScoreItem } from '../types';
	import { isTauri } from '../paths';
	import {
		latestOmr,
		omrStatus,
		convertAutomatically,
		cancelOmr,
		saveOmrArtifact,
		cacheOmrPdf,
		type OmrJob
	} from '../omr';
	let {
		score,
		onClose,
		embedded = false,
		autoStart = false,
		initialJob,
		onOpenResult,
		onKeepResult,
		onJobChanged
	}: {
		score: ScoreItem;
		onClose: () => void;
		embedded?: boolean;
		autoStart?: boolean;
		initialJob?: OmrJob;
		onOpenResult?: (job: OmrJob, index: number) => Promise<void>;
		onKeepResult?: (job: OmrJob, index: number) => Promise<void>;
		onJobChanged?: (job: OmrJob) => void;
	} = $props();
	let job = $state<OmrJob | null>(null);
	let busy = $state(false);
	let loading = $state(true);
	let error = $state('');
	let notice = $state('');
	let resultBusy = $state(false);
	let cachedPath = '';
	const desktop = isTauri();
	const stageLabels: Record<string, string> = {
		LOAD: 'Loading page',
		BINARY: 'Preparing image',
		SCALE: 'Measuring staff spacing',
		GRID: 'Finding staves and systems',
		HEADERS: 'Reading clefs and key signatures',
		STEM_SEEDS: 'Finding stems',
		BEAMS: 'Reading beams',
		LEDGERS: 'Reading ledger lines',
		HEADS: 'Recognizing notes',
		STEMS: 'Connecting notes and stems',
		REDUCTION: 'Resolving symbols',
		CUE_BEAMS: 'Reading cue notes',
		TEXTS: 'Reading text and expression marks',
		MEASURES: 'Building measures',
		CHORDS: 'Building chords',
		CURVES: 'Reading ties and slurs',
		SYMBOLS: 'Reading musical symbols',
		LINKS: 'Connecting musical details',
		RHYTHMS: 'Resolving rhythms and voices',
		PAGE: 'Assembling page'
	};
	let progress = $derived(job?.progress);
	let exporting = $derived(progress?.phase === 'exporting');
	let checkingLayout = $derived(progress?.phase === 'checking_layout');
	let total = $derived(progress?.total_pages || 0);
	let completed = $derived(Math.min(progress?.completed_pages || 0, total));
	let incomplete = $derived(
		job?.warnings.some(
			(w) =>
				w.startsWith('Source page ') ||
				w.startsWith('Score structure needs review:')
		) || false
	);

	let reviewNeeded = $derived(
		incomplete ||
			job?.artifacts.some((a) => (a.review?.warnings.length || 0) > 0)
	);

	onMount(() => {
		job = initialJob || null;
		let alive = true;
		let timer: ReturnType<typeof setTimeout>;
		async function refresh() {
			const requestedId = job?.id;
			try {
				if (busy) return;
				const next = job ? await omrStatus(job.id) : await latestOmr(score.id);
				if (!alive || busy || requestedId !== job?.id) return;
				if (next?.status !== 'running' && notice === 'Stopping conversion…')
					notice = '';
				job = next;
				if (next) onJobChanged?.(next);
			} catch (e) {
				if (alive) error = String(e);
			} finally {
				if (alive) {
					loading = false;
					timer = setTimeout(refresh, job?.status === 'running' ? 1500 : 5000);
				}
			}
		}
		if (desktop)
			void refresh().then(() => {
				if (alive && autoStart && !job) void convert();
			});
		else loading = false;
		return () => {
			alive = false;
			clearTimeout(timer);
		};
	});

	async function convert() {
		busy = true;
		error = '';
		notice = '';
		try {
			let inputPath = score.nativePath || cachedPath || null;
			if (!inputPath && score.pdfBlob) {
				cachedPath = await cacheOmrPdf(score.pdfBlob);
				inputPath = cachedPath;
			}
			const context = [
				score.title,
				score.composer,
				score.composerCountry,
				score.ensemble,
				score.instruments,
				...(score.tags || [])
			]
				.filter(Boolean)
				.join(' ');
			job = await convertAutomatically(score.id, inputPath, context);
			onJobChanged?.(job);
		} catch (e) {
			error = String(e);
		} finally {
			busy = false;
		}
	}
	async function cancel() {
		if (!job) return;
		try {
			await cancelOmr(job.id);
			notice = 'Stopping conversion…';
		} catch (e) {
			error = String(e);
		}
	}
	async function save(index: number) {
		if (!job) return;
		try {
			if (await saveOmrArtifact(job.id, index)) notice = 'File saved.';
		} catch (e) {
			error = String(e);
		}
	}
	async function useResult(index: number, keep: boolean) {
		if (!job || resultBusy) return;
		resultBusy = true;
		error = '';
		notice = '';
		try {
			await (keep ? onKeepResult?.(job, index) : onOpenResult?.(job, index));
			if (keep) notice = 'MusicXML added to your library.';
		} catch (e) {
			error = String(e);
		} finally {
			resultBusy = false;
		}
	}
</script>

{#snippet content()}
	<div class="body">
		{#if !desktop}
			<p>
				Open Sonora on your desktop to convert PDFs and photos. Existing
				MusicXML can be read here.
			</p>
		{:else}
			{#if job?.status === 'running'}
				<div class="progress-card" role="status" aria-live="polite">
					<div class="progress-heading">
						<span class="eyebrow">LOCAL CONVERSION</span><span
							class="activity-dot"></span>
					</div>
					<h2>
						{exporting
							? 'Creating your MusicXML score'
							: checkingLayout
								? 'Checking score structure'
								: progress?.phase === 'recovering'
									? 'Finishing saved recognition'
									: 'Reading your music'}
					</h2>
					<p class="stage">
						{exporting
							? 'Preserving the notation and preparing your score to view.'
							: checkingLayout
								? 'Keeping instruments, staves, and voices consistent across the score.'
								: stageLabels[progress?.step || ''] ||
									'Preparing the score for recognition'}{#if !exporting && !checkingLayout && progress?.current_page}
							· Page {progress.current_page}{/if}
					</p>
					{#if total && !exporting && !checkingLayout}
						<div class="page-count">
							<span>Source pages processed</span><strong
								>{completed} / {total}</strong>
						</div>
						<progress
							max={total}
							value={completed}
							aria-label="Source pages processed"></progress>
					{:else}<progress
							aria-label={exporting
								? 'Creating MusicXML'
								: checkingLayout
									? 'Checking score structure'
									: 'Preparing recognition'}></progress
						>{/if}
					<ol class="conversion-steps" aria-label="Conversion stages">
						<li class="done"><span>✓</span> Prepare</li>
						<li class:done={exporting} class:active={!exporting}>
							<span>{exporting ? '✓' : '2'}</span> Recognize
						</li>
						<li class:active={exporting}><span>3</span> MusicXML</li>
					</ol>
					<p class="hint">
						{progress?.phase === 'recovering'
							? 'Reusing saved pages and retrying the interrupted recognition. '
							: ''}You can leave this page while conversion continues.
					</p>
				</div>
				<button onclick={cancel}>Cancel</button>
			{:else if busy}
				<div class="progress-card" role="status">
					<span class="eyebrow">LOCAL CONVERSION</span>
					<h2>Preparing local recognition</h2>
					<progress aria-label="Preparing local recognition"></progress>
					<p>
						The first conversion downloads the tools it needs. Your score stays
						on your computer.
					</p>
				</div>
			{:else}
				{#if !job}<h2>Ready when you are</h2>
					<p>
						Sonora takes care of the recognition settings and creates a MusicXML
						score you can read here.
					</p>{/if}
				<button
					class:primary={!job || job.status !== 'complete'}
					disabled={loading}
					onclick={convert}
					>{loading
						? 'Checking saved conversion…'
						: job
							? 'Convert again'
							: 'Convert'}</button>
			{/if}
			{#if error}<p role="alert" class="error">{error}</p>{/if}
			{#if notice}<p role="status" class="notice">{notice}</p>{/if}
			{#if job}
				<section aria-label="Conversion result">
					{#if job.status !== 'running'}<h2>
							{job.status === 'complete'
								? reviewNeeded
									? 'Your score needs review'
									: 'Your score is ready'
								: job.status === 'cancelled'
									? 'Conversion cancelled'
									: 'Conversion needs attention'}
						</h2>{/if}
					{#if job.error}<p class="error">{job.error}</p>{/if}
					{#if reviewNeeded && job.status === 'complete'}<p class="warning">
							Review the conversion notes and flagged measures against the
							original before editing or transposing.
						</p>{/if}
					{#if job.warnings.length}<details>
							<summary>Conversion notes ({job.warnings.length})</summary
							>{#each job.warnings as warning}<p class="warning">
									{warning}
								</p>{/each}
						</details>{/if}
					{#each job.artifacts as artifact, index}
						<div class="artifact">
							{#if artifact.kind === 'musicxml'}
								<strong>{artifact.name.split(/[/\\]/).at(-1)}</strong>
								{#if artifact.review}{@const r = artifact.review}
									<p class="hint">
										{r.parts}
										{r.parts === 1 ? 'part' : 'parts'} · {r.notes} notes
									</p>
									{#if r.warnings.length}<details>
											<summary
												>{r.warnings.length}
												{r.warnings.length === 1 ? 'place' : 'places'} to review</summary>
											<p class="hint">
												Check these measures against the original score.
											</p>
											{#each r.warnings as warning}<p class="warning">
													{warning}
												</p>{/each}
										</details>{/if}
								{/if}
								<div class="result-actions">
									{#if onOpenResult}<button
											class="primary"
											disabled={resultBusy}
											onclick={() => useResult(index, false)}
											>{resultBusy ? 'Opening score…' : 'View score'}</button
										>{/if}
									{#if onKeepResult}<button
											disabled={resultBusy}
											onclick={() => useResult(index, true)}
											>Add to library</button
										>{/if}
									<button onclick={() => save(index)}>Download MusicXML</button>
								</div>
							{:else}<button onclick={() => save(index)}
									>Save editable project</button
								>{/if}
						</div>
					{/each}
					{#if job.log_tail}<details>
							<summary>Conversion log</summary>
							<pre>{job.log_tail}</pre>
						</details>{/if}
				</section>
			{/if}
		{/if}
	</div>
{/snippet}

{#if embedded}<div class="embedded">{@render content()}</div>{:else}<ViewerPanel
		title="Convert score"
		eyebrow="Local music recognition"
		{onClose}>{@render content()}</ViewerPanel
	>{/if}

<style>
	.body {
		padding: 20px 22px 24px;
		font-size: 13px;
		line-height: 1.6;
	}
	.embedded .body {
		padding: 28px;
		font-size: 14px;
	}
	h2 {
		margin: 0 0 10px;
		font-size: 19px;
		letter-spacing: -0.025em;
	}
	p {
		margin: 8px 0 16px;
		color: var(--sonora-text-secondary);
	}
	.hint {
		color: var(--sonora-text-muted);
		font-size: 12px;
	}
	button {
		padding: 10px 14px;
		border-radius: 9px;
		border: 1px solid var(--sonora-border-strong);
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
		cursor: pointer;
		font: inherit;
		font-size: 13px;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button.primary {
		background: var(--sonora-accent);
		color: var(--sonora-bg);
		font-weight: 600;
	}
	.body > .primary {
		width: 100%;
	}
	.result-actions {
		display: flex;
		flex-wrap: wrap;
		gap: 8px;
		margin: 14px 0 4px;
	}
	details {
		margin: 14px 0;
	}
	summary {
		cursor: pointer;
		font-size: 12px;
	}
	section {
		margin-top: 24px;
	}
	.artifact {
		padding: 16px 0;
		border-top: 1px solid var(--sonora-border-strong);
		overflow-wrap: anywhere;
	}
	.error {
		color: var(--sonora-danger);
	}
	.notice {
		color: var(--sonora-accent);
	}
	.warning {
		border-left: 2px solid var(--sonora-accent);
		padding-left: 10px;
		font-size: 12px;
	}
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 10px;
		max-height: 260px;
		overflow: auto;
	}
	.progress-card {
		padding: 22px;
		margin-bottom: 16px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 14px;
		background: var(--sonora-bg-hover);
	}
	.progress-heading,
	.page-count {
		display: flex;
		justify-content: space-between;
		align-items: center;
		gap: 12px;
	}
	.eyebrow {
		font-size: 10px;
		letter-spacing: 0.12em;
		color: var(--sonora-text-muted);
	}
	.progress-card h2 {
		margin-top: 14px;
	}
	.stage {
		min-height: 42px;
	}
	.page-count {
		font-size: 12px;
		margin: 20px 0 8px;
		color: var(--sonora-text-secondary);
	}
	.page-count strong {
		font-variant-numeric: tabular-nums;
		color: var(--sonora-text);
	}
	progress {
		display: block;
		width: 100%;
		height: 7px;
		accent-color: var(--sonora-accent);
		border: 0;
		border-radius: 8px;
		overflow: hidden;
		background: var(--sonora-border-strong);
	}
	progress::-webkit-progress-bar {
		background: var(--sonora-border-strong);
		border-radius: 8px;
	}
	progress::-webkit-progress-value {
		background: var(--sonora-accent);
		border-radius: 8px;
		transition: width 0.4s ease;
	}
	progress::-moz-progress-bar {
		background: var(--sonora-accent);
		border-radius: 8px;
	}
	progress:indeterminate {
		background: linear-gradient(
			90deg,
			var(--sonora-border-strong) 20%,
			var(--sonora-accent) 50%,
			var(--sonora-border-strong) 80%
		);
		background-size: 200% 100%;
		animation: travel 2s ease-in-out infinite;
	}
	.conversion-steps {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 8px;
		list-style: none;
		padding: 0;
		margin: 22px 0;
		font-size: 11px;
		color: var(--sonora-text-muted);
	}
	.conversion-steps li {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 6px;
	}
	.conversion-steps span {
		display: grid;
		place-items: center;
		width: 21px;
		height: 21px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 50%;
	}
	.conversion-steps .active {
		color: var(--sonora-text);
	}
	.conversion-steps .active span,
	.conversion-steps .done span {
		border-color: var(--sonora-accent);
		color: var(--sonora-accent);
	}
	.activity-dot {
		width: 7px;
		height: 7px;
		border-radius: 50%;
		background: var(--sonora-accent);
	}
	@keyframes travel {
		to {
			background-position: -200% 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		progress:indeterminate {
			animation: none;
		}
		progress::-webkit-progress-value {
			transition: none;
		}
	}
</style>
