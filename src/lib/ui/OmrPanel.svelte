<script lang="ts">
	import { onMount } from 'svelte';
	import ViewerPanel from './ViewerPanel.svelte';
	import type { ScoreItem } from '../types';
	import { isTauri } from '../paths';
	import {
		defaultOmrOptions,
		latestOmr,
		omrStatus,
		startOmr,
		cancelOmr,
		pickOmrEngine,
		pickOmrTessdata,
		saveOmrArtifact,
		type OmrJob
	} from '../omr';
	let { score, onClose }: { score: ScoreItem; onClose: () => void } = $props();
	let options = $state(defaultOmrOptions());
	let engine = $state('');
	let job = $state<OmrJob | null>(null);
	let busy = $state(false);
	let loading = $state(true);
	let error = $state('');
	let notice = $state('');
	let chooseInput = $state(false);
	const desktop = isTauri();

	onMount(() => {
		let alive = true;
		let timer: ReturnType<typeof setTimeout>;
		try {
			engine = localStorage.getItem('sonora.omr.engine') || '';
			options.tessdata_path = localStorage.getItem('sonora.omr.tessdata') || '';
		} catch {
			/* optional preference */
		}
		async function refresh() {
			const requestedId = job?.id;
			try {
				if (busy) return;
				const next = job ? await omrStatus(job.id) : await latestOmr(score.id);
				if (!alive || busy || requestedId !== job?.id) return;
				if (next?.status !== 'running' && notice === 'Stopping recognition…')
					notice = '';
				if (!job && next) options = { ...next.options };
				job = next;
			} catch (e) {
				if (alive) error = String(e);
			} finally {
				if (alive) {
					loading = false;
					timer = setTimeout(refresh, job?.status === 'running' ? 1500 : 5000);
				}
			}
		}
		if (desktop) void refresh();
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
			try {
				localStorage.setItem('sonora.omr.engine', engine);
				localStorage.setItem('sonora.omr.tessdata', options.tessdata_path);
			} catch {
				/* optional preference */
			}
			job = await startOmr(
				score.id,
				chooseInput ? null : score.nativePath || null,
				engine,
				options
			);
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
			notice = 'Stopping recognition…';
		} catch (e) {
			error = String(e);
		}
	}
	async function chooseEngine() {
		try {
			const path = await pickOmrEngine();
			if (path) engine = path;
		} catch (e) {
			error = String(e);
		}
	}
	async function chooseTessdata() {
		try {
			const path = await pickOmrTessdata();
			if (path) options.tessdata_path = path;
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
</script>

<ViewerPanel title="Digitize score" eyebrow="Local music recognition" {onClose}>
	<div class="body">
		{#if !desktop}
			<p>
				Score recognition runs in the Sonora desktop app with Audiveris
				installed locally.
			</p>
		{:else}
			<p>
				Create editable MusicXML from the original PDF or a score photo. Review
				the result against the PDF before transposing or editing.
			</p>
			<details>
				<summary>Audiveris setup</summary>
				<p>
					Install <a
						href="https://github.com/Audiveris/audiveris/releases/tag/5.11.0"
						target="_blank"
						rel="noreferrer">Audiveris 5.11</a
					>, including OCR language data for the score. Choose its launcher
					below, or leave this blank to use Audiveris on your PATH.
				</p>
				<label
					>Audiveris launcher<input
						bind:value={engine}
						placeholder="Audiveris" /></label>
				<button onclick={chooseEngine}>Choose launcher…</button>
				<label
					>OCR data folder<input
						bind:value={options.tessdata_path}
						placeholder="Detect installed tessdata" /></label>
				<button onclick={chooseTessdata}>Choose OCR data folder…</button>
				<p class="hint">
					Install the needed languages in Audiveris under Tools → Languages, or
					select an existing Tesseract data folder. Missing languages are
					checked before conversion.
				</p>
			</details>
			<details open={!job}>
				<summary>Recognition settings</summary>
				<fieldset disabled={busy || job?.status === 'running' || loading}>
					<legend>Score features</legend>
					<label
						>PDF detail<select bind:value={options.dpi}
							><option value={400}>Fine notation · 400 DPI</option><option
								value={300}>Standard notation · 300 DPI</option
							></select
						></label>
					<div class="range">
						<label
							>First page<input
								type="number"
								min="1"
								max={chooseInput ? 100000 : score.totalPages || 100000}
								step="1"
								bind:value={options.first_page} /></label>
						<label
							>Last page<input
								type="number"
								min={options.first_page}
								max={chooseInput ? 100000 : score.totalPages || 100000}
								step="1"
								value={options.last_page ?? ''}
								oninput={(event) =>
									(options.last_page =
										event.currentTarget.value === ''
											? null
											: Number(event.currentTarget.value))}
								placeholder="End" /></label>
					</div>
					<p class="hint">
						Use PDF page numbers. Exclude covers and prose pages. Leave the last
						page blank only when starting at page 1.
					</p>
					<label class="check"
						><input
							type="checkbox"
							bind:checked={options.lyrics} />Lyrics</label>
					<label
						>OCR languages<input
							bind:value={options.languages}
							placeholder="eng or deu+eng" /></label>
					<p class="hint">
						Use installed three-letter language codes, such as eng, deu, fra,
						ita or lat. Match the sung language for vocal scores.
					</p>
					<label class="check"
						><input type="checkbox" bind:checked={options.lyrics_above} />Lyrics
						above the staff</label>
					<label class="check"
						><input type="checkbox" bind:checked={options.small_notes} />Cue
						notes and small noteheads / beams</label>
					<label class="check"
						><input
							type="checkbox"
							bind:checked={options.tremolos} />Tremolos</label>
					<label class="check"
						><input
							type="checkbox"
							bind:checked={options.fingerings} />Fingering digits</label>
					<p class="hint">
						Enable cues and fingerings when present; unnecessary symbol searches
						can introduce errors. Articulations, slurs and dynamics are
						included.
					</p>
					<label class="check"
						><input type="checkbox" bind:checked={chooseInput} />Choose another
						PDF or photo</label>
				</fieldset>
			</details>
			{#if job?.status === 'running'}
				<p role="status">
					Recognizing locally… You can close this panel while it runs.
				</p>
				<button onclick={cancel}>Cancel recognition</button>
			{:else}
				<button class="primary" disabled={busy || loading} onclick={convert}
					>{loading
						? 'Loading saved result…'
						: busy
							? 'Preparing…'
							: job
								? 'Recognize again'
								: 'Create MusicXML'}</button>
			{/if}
			{#if error}<p role="alert" class="error">{error}</p>{/if}
			{#if notice}<p role="status">{notice}</p>{/if}
			{#if job}
				<section aria-label="Recognition result">
					<h3>
						{job.status === 'complete'
							? 'Ready for review'
							: job.status === 'running'
								? 'Recognition in progress'
								: `Recognition ${job.status}`}
					</h3>
					<details>
						<summary>Source and settings</summary>
						<p class="hint">
							{job.source}<br />{new Date(
								job.created_at
							).toLocaleString()}<br />{job.options.dpi} DPI · pages {job
								.options.first_page}–{job.options.last_page ?? 'end'} · OCR {job
								.options.languages}
						</p>
					</details>
					{#if job.error}<p class="error">{job.error}</p>{/if}
					{#each job.warnings as warning}<p class="warning">{warning}</p>{/each}
					{#each job.artifacts as artifact, index}
						<div class="artifact">
							<strong>{artifact.name.split(/[/\\]/).at(-1)}</strong>
							{#if artifact.review}
								{@const r = artifact.review}
								<p>
									{r.parts} parts · {r.measures} part-measures · {r.notes} notes ·
									{r.rests} rests
								</p>
								<p class="hint">
									{r.articulations} articulations · {r.slurs} slurs · {r.ties} ties
									· {r.dynamics} dynamics · {r.lyrics} lyric syllables
								</p>
								<details>
									<summary
										>Structural review ({r.warnings.length}{r.warnings
											.length === 200
											? '+'
											: ''})</summary>
									<p class="hint">
										These checks flag possible errors; they cannot confirm that
										the recognized music matches the page.
									</p>
									{#each r.warnings as warning}<p class="warning">
											{warning}
										</p>{:else}<p>No structural issues detected.</p>{/each}
								</details>
							{/if}
							<button
								disabled={job.status === 'running'}
								onclick={() => save(index)}
								>{artifact.kind === 'musicxml'
									? 'Save MusicXML…'
									: 'Save editable Audiveris project…'}</button>
						</div>
					{/each}
					{#if job.log_tail}<details>
							<summary>Recognition log</summary>
							<pre>{job.log_tail}</pre>
						</details>{/if}
				</section>
			{/if}
		{/if}
	</div>
</ViewerPanel>

<style>
	.body {
		padding: 12px 22px 22px;
		font-size: 13px;
		line-height: 1.5;
	}
	p {
		margin: 8px 0 12px;
	}
	.hint {
		color: var(--sonora-text-muted);
		font-size: 12px;
	}
	fieldset {
		border: 0;
		padding: 0;
		margin: 16px 0;
		min-width: 0;
	}
	legend {
		font-weight: 600;
		margin-bottom: 8px;
	}
	label {
		display: grid;
		gap: 4px;
		margin: 8px 0;
	}
	label.check {
		display: flex;
		align-items: center;
		gap: 8px;
	}
	.range {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: 12px;
	}
	input:not([type='checkbox']),
	select {
		width: 100%;
		box-sizing: border-box;
		padding: 7px;
		background: var(--sonora-bg);
		color: var(--sonora-text);
		border: 1px solid var(--sonora-border-strong);
		border-radius: 6px;
	}
	button {
		padding: 8px 12px;
		border-radius: 8px;
		border: 1px solid var(--sonora-border-strong);
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
		cursor: pointer;
	}
	button:disabled {
		opacity: 0.5;
		cursor: default;
	}
	button.primary {
		background: var(--sonora-accent);
		color: white;
		width: 100%;
	}
	details {
		margin: 12px 0;
	}
	summary {
		cursor: pointer;
		font-weight: 500;
	}
	section {
		border-top: 1px solid var(--sonora-border-strong);
		margin-top: 18px;
	}
	h3 {
		font-size: 14px;
	}
	.artifact {
		padding: 12px 0;
		border-top: 1px solid var(--sonora-border-strong);
		overflow-wrap: anywhere;
	}
	.error {
		color: var(--sonora-danger);
	}
	.warning {
		border-left: 2px solid var(--sonora-accent);
		padding-left: 8px;
	}
	pre {
		white-space: pre-wrap;
		overflow-wrap: anywhere;
		font-size: 10px;
		max-height: 260px;
		overflow: auto;
	}
	a {
		color: var(--sonora-accent);
	}
</style>
