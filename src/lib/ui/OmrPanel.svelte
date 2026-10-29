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
				<div class="progress" role="status">
					<span class="spinner"></span>
					<div>
						<strong>Converting your score</strong>
						<p>
							Recognizing the music and its details. You can leave this page
							while it works.
						</p>
					</div>
				</div>
				<button onclick={cancel}>Cancel</button>
			{:else if busy}
				<div class="progress" role="status">
					<span class="spinner"></span>
					<div>
						<strong>Preparing local recognition</strong>
						<p>
							The first conversion downloads the tools it needs. Your score
							stays on your computer.
						</p>
					</div>
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
								? 'Your score is ready'
								: job.status === 'cancelled'
									? 'Conversion cancelled'
									: 'Conversion needs attention'}
						</h2>{/if}
					{#if job.error}<p class="error">{job.error}</p>{/if}
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
	.progress {
		display: flex;
		gap: 14px;
		align-items: flex-start;
	}
	.progress strong {
		font-size: 16px;
	}
	.progress p {
		font-size: 13px;
	}
	.spinner {
		width: 22px;
		height: 22px;
		flex: 0 0 auto;
		margin-top: 4px;
		border: 2px solid var(--sonora-border-strong);
		border-top-color: var(--sonora-accent);
		border-radius: 50%;
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.spinner {
			animation: none;
		}
	}
</style>
