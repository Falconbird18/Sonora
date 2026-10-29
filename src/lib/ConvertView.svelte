<script lang="ts">
	import { onMount } from 'svelte';
	import {
		FileMusic,
		FileUp,
		ArrowRight,
		Check,
		ScanLine,
		BookOpen
	} from '@lucide/svelte';
	import OmrPanel from './ui/OmrPanel.svelte';
	import { isTauri } from './paths';
	import { getPdfInfoFromSource } from './pdfUtils';
	import { listOmr, pickOmrInput, type OmrJob } from './omr';
	import {
		convertedMusicXml,
		prepareMusicXml,
		keepMusicXml
	} from './musicXmlImport';
	import { resolveScoreSource } from './folderSync';
	import { db } from './db';
	import type { ScoreItem } from './types';
	let {
		scores,
		onOpen,
		onChanged
	}: {
		scores: ScoreItem[];
		onOpen: (score: ScoreItem) => void;
		onChanged: () => Promise<void>;
	} = $props();
	let source = $state<ScoreItem | null>(null);
	let jobs = $state<OmrJob[]>([]);
	let error = $state('');
	let busy = $state(false);
	let musicFile: HTMLInputElement;
	let selectedId = $state('');
	let openingJob = $state('');
	let autoStart = $state(false);
	const desktop = isTauri();
	const pdfs = $derived(scores.filter((s) => s.format !== 'musicxml'));
	const current = $derived(
		jobs.find((j) =>
			openingJob ? j.id === openingJob : j.score_id === source?.id
		)
	);
	const step = $derived(!source ? 1 : current?.status === 'complete' ? 3 : 2);

	onMount(() => {
		let alive = true;
		if (desktop)
			void listOmr()
				.then((value) => {
					if (alive) jobs = value;
				})
				.catch((e) => {
					if (alive) error = String(e);
				});
		return () => {
			alive = false;
		};
	});
	function jobChanged(job: OmrJob) {
		jobs = [job, ...jobs.filter((item) => item.id !== job.id)].sort(
			(a, b) => b.created_at - a.created_at
		);
	}
	async function chooseSource() {
		busy = true;
		error = '';
		try {
			const path = await pickOmrInput();
			if (!path) return;
			const info = /\.pdf$/i.test(path)
				? await getPdfInfoFromSource({ nativePath: path })
				: { totalPages: 1, thumbnailUrl: '' };
			source = {
				id: `convert:${crypto.randomUUID()}`,
				title: path
					.split(/[/\\]/)
					.at(-1)!
					.replace(/\.[^.]+$/, ''),
				composer: 'Unknown Composer',
				nativePath: path,
				totalPages: info.totalPages,
				thumbnailUrl: info.thumbnailUrl,
				addedAt: Date.now()
			};
			selectedId = '';
			openingJob = '';
			autoStart = true;
		} catch (e) {
			error = String(e);
		} finally {
			busy = false;
		}
	}
	async function chooseLibrary() {
		const score = pdfs.find((item) => item.id === selectedId);
		if (!score) return;
		const folder = await db.folders.get('library-root');
		const resolved = resolveScoreSource(score, folder);
		source = {
			...score,
			nativePath: resolved.nativePath,
			pdfUrl: resolved.url,
			pdfBlob: resolved.blob
		};
		openingJob = '';
		autoStart = false;
	}
	async function openExisting(event: Event) {
		const file = (event.currentTarget as HTMLInputElement).files?.[0];
		if (!file) return;
		busy = true;
		error = '';
		try {
			const score = await prepareMusicXml(file, file.name);
			await keepMusicXml(score);
			await onChanged();
			onOpen(score);
		} catch (e) {
			error = String(e);
		} finally {
			busy = false;
			musicFile.value = '';
		}
	}
	async function useResult(job: OmrJob, index: number, keep: boolean) {
		const origin =
			scores.find((s) => s.id === job.score_id) || source || undefined;
		const score = await convertedMusicXml(job, index, origin);
		if (keep) {
			await keepMusicXml(score);
			await onChanged();
		} else onOpen(score);
	}
	function resume(job: OmrJob) {
		autoStart = false;
		openingJob = job.id;
		source = scores.find((s) => s.id === job.score_id) || {
			id: job.score_id,
			title: job.source
				.split(/[/\\]/)
				.at(-1)!
				.replace(/\.[^.]+$/, ''),
			composer: 'Unknown Composer',
			nativePath: job.source,
			totalPages: job.options.last_page || 0,
			addedAt: job.created_at
		};
		selectedId = scores.some((s) => s.id === source?.id) ? source.id : '';
	}
</script>

<div class="convert-workspace">
	<header class="intro">
		<div>
			<span class="eyebrow">From printed page to digital score</span>
			<h1>Convert your score</h1>
			<p>
				Bring printed music into Sonora as MusicXML. Keep the details, review
				the result, and build your digital library.
			</p>
		</div>
		<input
			class="file-input"
			type="file"
			accept=".musicxml,.xml,.mxl"
			bind:this={musicFile}
			onchange={openExisting}
			aria-label="Open existing MusicXML" />
		<button class="secondary" disabled={busy} onclick={() => musicFile.click()}
			><FileMusic size={17} />Open MusicXML</button>
	</header>
	<ol class="steps" aria-label="Conversion steps">
		{#each ['Choose a score', 'Recognize the music', 'Review & keep'] as label, index}<li
				class:active={step === index + 1}
				class:done={step > index + 1}>
				<span
					>{#if step > index + 1}<Check size={15} />{:else}{index +
							1}{/if}</span
				>{label}{#if index < 2}<ArrowRight size={15} />{/if}
			</li>{/each}
	</ol>
	{#if error}<p class="error" role="alert">{error}</p>{/if}
	<div class="workflow">
		<section class="source-card" aria-label="Conversion source">
			<div class="card-icon"><FileUp size={25} /></div>
			<h2>Your source score</h2>
			<p>
				Start with a clean PDF, scan, or photo. Processing stays on your
				computer.
			</p>
			<button class="primary" disabled={busy || !desktop} onclick={chooseSource}
				>{busy
					? 'Opening…'
					: source
						? 'Convert another score'
						: 'Convert a score'}</button>
			{#if !desktop}<p class="hint">
					PDF recognition is available in the desktop app. You can open and read
					existing MusicXML here.
				</p>{/if}
			{#if pdfs.length}<div class="divider">or from your library</div>
				<label
					>Library score<select
						bind:value={selectedId}
						onchange={() =>
							void chooseLibrary().catch((e) => (error = String(e)))}
						><option value="">Choose a score…</option
						>{#each pdfs as score}<option value={score.id}>{score.title}</option
							>{/each}</select
					></label
				>{/if}
			{#if source}<div class="chosen">
					{#if source.thumbnailUrl}<img
							src={source.thumbnailUrl}
							alt="Source score preview" />{:else}<BookOpen size={30} />{/if}
					<div>
						<strong>{source.title}</strong>
						<p>
							{source.totalPages || 'Unknown number of'}
							{source.totalPages === 1 ? 'page' : 'pages'}
						</p>
					</div>
				</div>{/if}
			<div class="tips">
				<strong>A good starting point</strong>
				<p>
					Use an upright, evenly lit page. Sonora prepares local recognition and
					chooses the settings automatically.
				</p>
			</div>
		</section>
		<section class="recognition-card" aria-label="Recognition and results">
			{#if source}
				{#key `${source.id}:${openingJob}`}<OmrPanel
						score={source}
						initialJob={jobs.find(
							(j) => j.id === openingJob && j.score_id === source?.id
						)}
						embedded
						{autoStart}
						onClose={() => {}}
						onJobChanged={jobChanged}
						onOpenResult={(job, index) => useResult(job, index, false)}
						onKeepResult={(job, index) => useResult(job, index, true)} />{/key}
			{:else}<div class="waiting">
					<ScanLine size={40} strokeWidth={1.2} />
					<h2>Give your score a new life</h2>
					<p>
						Choose a score and Sonora takes care of recognition. Your finished
						movements will appear here, ready to view or add to the library.
					</p>
					<span>PDF / photo → MusicXML → Sonora</span>
				</div>{/if}
		</section>
	</div>
	{#if jobs.length}<section class="history">
			<div>
				<h2>Recent conversions</h2>
				<p>Pick up where you left off.</p>
			</div>
			{#each jobs.slice(0, 15) as job}<button
					class="history-row"
					onclick={() => resume(job)}
					><FileMusic size={20} /><span
						><strong>{job.source.split(/[/\\]/).at(-1)}</strong><small
							>{new Date(job.created_at).toLocaleString()}</small
						></span
					><b>{job.status === 'complete' ? 'Ready to review' : job.status}</b
					><ArrowRight size={17} /></button
				>{/each}
		</section>{/if}
</div>

<style>
	.convert-workspace {
		max-width: 1180px;
		margin: 0 auto;
		padding: 34px 36px 60px;
	}
	.intro {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 28px;
	}
	.eyebrow {
		text-transform: uppercase;
		letter-spacing: 0.16em;
		color: var(--sonora-accent);
		font-size: 10px;
		font-weight: 600;
	}
	h1 {
		font-size: 30px;
		letter-spacing: -0.045em;
		margin: 8px 0 12px;
	}
	h2 {
		font-size: 18px;
		margin: 12px 0 8px;
		letter-spacing: -0.02em;
	}
	p {
		color: var(--sonora-text-secondary);
		line-height: 1.65;
		font-size: 13px;
		margin: 0 0 16px;
		max-width: 580px;
	}
	button {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 8px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 10px;
		padding: 11px 16px;
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
		width: 100%;
	}
	.secondary {
		white-space: nowrap;
	}
	.file-input {
		display: none;
	}
	.steps {
		list-style: none;
		padding: 22px 0;
		margin: 12px 0 16px;
		display: flex;
		gap: 18px;
		border-bottom: 1px solid var(--sonora-border-strong);
	}
	.steps li {
		display: flex;
		align-items: center;
		gap: 9px;
		font-size: 12px;
		color: var(--sonora-text-muted);
	}
	.steps li > span {
		display: grid;
		place-items: center;
		width: 25px;
		height: 25px;
		border-radius: 50%;
		background: var(--sonora-bg-hover);
		border: 1px solid var(--sonora-border-strong);
	}
	.steps .active,
	.steps .done {
		color: var(--sonora-text);
	}
	.steps .active > span {
		background: var(--sonora-accent);
		color: var(--sonora-bg);
	}
	.workflow {
		display: grid;
		grid-template-columns: minmax(220px, 0.8fr) minmax(0, 1.4fr);
		gap: 22px;
		align-items: start;
	}
	.source-card,
	.recognition-card {
		border: 1px solid var(--sonora-border-strong);
		border-radius: 18px;
		background: var(--sonora-bg-elevated);
		overflow: hidden;
	}
	.source-card {
		padding: 26px;
	}
	.card-icon {
		color: var(--sonora-accent);
		margin-bottom: 18px;
	}
	.divider {
		text-align: center;
		font-size: 11px;
		color: var(--sonora-text-muted);
		margin: 20px 0 14px;
	}
	label {
		display: grid;
		gap: 8px;
		font-size: 12px;
	}
	select {
		width: 100%;
		padding: 10px;
		background: var(--sonora-bg);
		color: var(--sonora-text);
		border: 1px solid var(--sonora-border-strong);
		border-radius: 8px;
	}
	.chosen {
		display: flex;
		gap: 14px;
		align-items: center;
		margin-top: 22px;
		border-top: 1px solid var(--sonora-border-strong);
		padding-top: 20px;
		overflow-wrap: anywhere;
	}
	.chosen img {
		width: 52px;
		height: 72px;
		object-fit: contain;
		background: white;
		border-radius: 4px;
	}
	.chosen strong {
		font-size: 13px;
	}
	.chosen p {
		margin: 4px 0 0;
		font-size: 11px;
	}
	.tips {
		border-top: 1px solid var(--sonora-border-strong);
		padding-top: 20px;
		margin-top: 22px;
		font-size: 12px;
	}
	.tips p,
	.hint {
		font-size: 12px;
		margin-top: 8px;
	}
	.waiting {
		display: grid;
		justify-items: center;
		text-align: center;
		padding: 80px 40px;
		color: var(--sonora-text-muted);
	}
	.waiting h2 {
		color: var(--sonora-text);
		margin-top: 22px;
	}
	.waiting span {
		font-size: 11px;
		color: var(--sonora-accent);
		margin-top: 20px;
	}
	.history {
		margin-top: 32px;
	}
	.history p {
		margin-bottom: 18px;
	}
	.history-row {
		display: flex;
		width: 100%;
		text-align: left;
		padding: 16px;
		margin-top: 8px;
		gap: 15px;
		background: var(--sonora-bg-elevated);
	}
	.history-row span {
		flex: 1;
		min-width: 0;
		overflow-wrap: anywhere;
	}
	.history-row strong,
	.history-row small {
		display: block;
	}
	.history-row small {
		font-size: 11px;
		color: var(--sonora-text-muted);
		margin-top: 4px;
	}
	.history-row b {
		font-size: 11px;
		color: var(--sonora-accent);
		font-weight: 500;
	}
	.error {
		padding: 12px;
		border: 1px solid var(--sonora-danger);
		border-radius: 10px;
		color: var(--sonora-danger);
	}
	@media (max-width: 1000px) {
		.convert-workspace {
			padding: 24px;
		}
		.workflow {
			grid-template-columns: 1fr;
		}
		.waiting {
			padding: 40px 24px;
		}
	}
	@media (max-width: 650px) {
		.intro {
			flex-direction: column;
			align-items: flex-start;
		}
		.steps {
			gap: 8px;
			flex-wrap: wrap;
		}
		.steps li {
			font-size: 11px;
		}
		.convert-workspace {
			padding: 20px 14px;
		}
	}
</style>
