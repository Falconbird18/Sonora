<script lang="ts">
	import { dialogFocus } from './dialogFocus';
	import {
		analyzeImport,
		applyImslpMatch,
		fileFingerprint,
		suggestFilename,
		type ImportCandidate
	} from '../scoreImport';
	import { imslpAvailable } from '../imslp';
	import { db } from '../db';
	import { plainScore } from '../scoreMeta';
	let {
		onClose,
		onImported,
		onChooseFolder
	}: {
		onClose: () => void;
		onImported: () => Promise<void>;
		onChooseFolder: () => Promise<void>;
	} = $props();
	let rows = $state<ImportCandidate[]>([]),
		busy = $state(false),
		progress = $state(''),
		online = $state(true),
		ocr = $state(false),
		error = $state('');
	let analyzing = $state(false),
		stopRequested = $state(false),
		dragging = $state(false);
	let cancelled = false;
	import { onDestroy } from 'svelte';
	onDestroy(() => (cancelled = true));
	async function selectFiles(files: FileList | File[] | null) {
		if (!files || busy) return;
		busy = true;
		analyzing = true;
		stopRequested = false;
		error = '';
		try {
			const existing = await db.scores.toArray();
			const hashes = new Set(
				existing.map((s) => s.contentHash).filter(Boolean)
			);
			const selected = Array.from(files).filter((f) => /\.pdf$/i.test(f.name));
			if (!selected.length) error = 'Choose PDF files to import.';
			for (const [index, file] of selected.entries()) {
				if (cancelled || stopRequested) break;
				progress = `Analyzing ${index + 1} of ${selected.length}: ${file.name}`;
				try {
					const hash = await fileFingerprint(file);
					if (cancelled || stopRequested) break;
					const duplicate =
						hashes.has(hash) || rows.some((r) => r.score.contentHash === hash);
					const row: ImportCandidate = duplicate
						? {
								file,
								score: {
									id: crypto.randomUUID(),
									...suggestFilename(file.name),
									totalPages: 1,
									addedAt: Date.now()
								},
								selected: false,
								duplicate: true,
								status: 'Duplicate PDF · already in library or this batch'
							}
						: await analyzeImport(file, online, ocr);
					row.score.contentHash = hash;
					if (!cancelled) rows = [...rows, row];
				} catch (e) {
					if (!cancelled)
						rows = [
							...rows,
							{
								file,
								score: {
									id: crypto.randomUUID(),
									...suggestFilename(file.name),
									totalPages: 1,
									addedAt: Date.now()
								},
								selected: false,
								status: 'Could not analyze file',
								error: String(e)
							}
						];
				}
			}
		} catch (e) {
			error = String(e);
		} finally {
			busy = false;
			analyzing = false;
			progress = '';
		}
	}
	async function match(row: ImportCandidate, title: string) {
		if (!title) return;
		busy = true;
		error = '';
		progress = 'Fetching IMSLP metadata…';
		try {
			await applyImslpMatch(row, title);
		} catch (e) {
			error = String(e);
		} finally {
			busy = false;
			progress = '';
		}
	}
	async function save() {
		busy = true;
		error = '';
		try {
			const chosen = rows.filter((r) => r.selected && !r.error && !r.duplicate);
			if (chosen.some((r) => !r.score.title.trim()))
				throw Error('Each selected score needs a title.');
			await db.transaction('rw', db.scores, async () => {
				for (const row of chosen)
					await db.scores.add(
						plainScore({ ...row.score, metadataEdited: true })
					);
			});
			rows = rows.filter((r) => !chosen.includes(r));
			await onImported();
			onClose();
		} catch (e) {
			error = String(e);
		} finally {
			busy = false;
		}
	}
</script>

<svelte:window
	onkeydown={(e) => {
		if (e.key === 'Escape' && !busy) {
			e.stopPropagation();
			onClose();
		}
	}} />
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
	class="import-backdrop"
	class:dragging
	ondragover={(e) => {
		e.preventDefault();
		dragging = true;
	}}
	ondragleave={(e) => {
		if (!e.currentTarget.contains(e.relatedTarget as Node)) dragging = false;
	}}
	ondrop={(e) => {
		e.preventDefault();
		dragging = false;
		void selectFiles(e.dataTransfer?.files || null);
	}}>
	<div
		class="import-dialog"
		role="dialog"
		aria-modal="true"
		aria-labelledby="import-title"
		use:dialogFocus>
		<header>
			<div>
				<h2 id="import-title">Import scores</h2>
				<p>
					Drop PDFs here or choose files and folders. Review titles and tags
					before saving.
				</p>
			</div>
			<button disabled={busy} onclick={onClose}>Close</button>
		</header>
		<div class="sources">
			<label class="file-button"
				>Choose PDFs<input
					type="file"
					accept=".pdf,application/pdf"
					multiple
					disabled={busy}
					onchange={(e) => void selectFiles(e.currentTarget.files)} /></label
			><label class="file-button"
				>Import a folder<input
					type="file"
					webkitdirectory
					multiple
					disabled={busy}
					onchange={(e) => void selectFiles(e.currentTarget.files)} /></label
			><button
				disabled={busy}
				onclick={async () => {
					await onChooseFolder();
					onClose();
				}}>Connect synced folder…</button>
		</div>
		<label class="online"
			><input
				type="checkbox"
				bind:checked={online}
				disabled={busy || !imslpAvailable()} />
			Look up metadata on IMSLP {imslpAvailable()
				? ''
				: '(desktop only)'}</label>
		<label class="online"
			><input
				type="checkbox"
				bind:checked={ocr}
				disabled={busy || !imslpAvailable()} /> Recognize scanned title pages locally
			(requires Tesseract + English data)</label>
		<p class="hint">
			Files are stored in Sonora; originals keep their names. PDF text stays on
			this device. Enable local OCR to read scanned title pages.
		</p>
		{#if busy}<p role="status">
				{progress || 'Saving scores…'}
			</p>{/if}{#if analyzing}<button
				disabled={stopRequested}
				onclick={() => (stopRequested = true)}
				>{stopRequested ? 'Stopping after this file…' : 'Stop analysis'}</button
			>{/if}
		{#if error}<p role="alert">{error}</p>{/if}
		{#if rows.length}<div class="batch">
				<strong
					>{rows.filter((r) => r.selected).length} of {rows.length} selected</strong
				><button
					disabled={busy}
					onclick={() =>
						(rows = rows.map((r) => ({
							...r,
							selected: !r.error && !r.duplicate
						})))}>Select all</button
				><button
					disabled={busy}
					onclick={() => (rows = rows.map((r) => ({ ...r, selected: false })))}
					>Select none</button>
			</div>{/if}
		<div class="review">
			{#each rows as row}<article>
					<div class="original">
						<input
							type="checkbox"
							bind:checked={row.selected}
							disabled={busy || !!row.error || row.duplicate}
							aria-label={`Import ${row.file.name}`} /><strong
							>{row.file.name}</strong
						><span>{row.status}</span>
					</div>
					<div class="fields">
						<label
							>Title<input
								bind:value={row.score.title}
								disabled={busy || !!row.error} /></label
						><label
							>Composer<input
								bind:value={row.score.composer}
								disabled={busy || !!row.error}
								oninput={() => {
									row.score.composerId = undefined;
								}} /></label
						><label
							>Tags<input
								value={row.score.tags?.join(', ') || ''}
								disabled={busy || !!row.error}
								oninput={(e) =>
									(row.score.tags = e.currentTarget.value
										.split(',')
										.map((t) => t.trim())
										.filter(Boolean))} /></label>
					</div>
					{#if row.matches?.length}<label class="match"
							>IMSLP suggestions<select
								aria-label={`IMSLP match for ${row.file.name}`}
								disabled={busy}
								value=""
								onchange={(e) => void match(row, e.currentTarget.value)}
								><option value="">Choose a matching work…</option
								>{#each row.matches as hit}<option value={hit.title}
										>{hit.title}</option
									>{/each}</select
							></label
						>{/if}
					<details>
						<summary>More metadata</summary>
						<div class="fields">
							<label
								>Catalogue<input
									bind:value={row.score.catalogue}
									disabled={busy} /></label
							><label
								>Key<input bind:value={row.score.key} disabled={busy} /></label
							><label
								>Instruments<input
									bind:value={row.score.instruments}
									disabled={busy} /></label>
						</div>
					</details>
					{#if row.error}<p role="alert">{row.error}</p>{/if}
				</article>{/each}
		</div>
		<footer>
			<span>Nothing is imported until you confirm.</span><button
				disabled={busy ||
					!rows.some((r) => r.selected && !r.error && !r.duplicate)}
				onclick={save}>Import selected scores</button>
		</footer>
	</div>
</div>

<style>
	.import-backdrop.dragging .import-dialog {
		outline: 3px solid var(--sonora-accent);
	}
	.file-button:focus-within {
		outline: 2px solid var(--sonora-accent);
		outline-offset: 3px;
	}
	.import-backdrop {
		position: fixed;
		inset: 0;
		z-index: 150;
		background: #0007;
		display: grid;
		place-items: center;
		padding: 24px;
	}
	.import-dialog {
		background: var(--sonora-bg-panel-solid);
		color: var(--sonora-text);
		border: 1px solid #8885;
		border-radius: 18px;
		padding: 26px;
		width: min(960px, 100%);
		max-height: 90vh;
		display: flex;
		flex-direction: column;
		gap: 18px;
		box-shadow: 0 20px 80px #0004;
	}
	header,
	footer,
	.sources,
	.batch {
		display: flex;
		align-items: center;
		gap: 12px;
		justify-content: space-between;
	}
	h2,
	p {
		margin: 0;
	}
	h2 {
		font-size: 26px;
	}
	header p,
	.hint {
		font-size: 13px;
		opacity: 0.7;
		margin-top: 8px;
	}
	button,
	.file-button {
		border: 1px solid #8885;
		border-radius: 8px;
		padding: 10px 14px;
		background: transparent;
		color: inherit;
		cursor: pointer;
		font: inherit;
	}
	.file-button {
		position: relative;
		overflow: hidden;
	}
	.file-button input {
		position: absolute;
		inset: 0;
		opacity: 0;
		cursor: pointer;
		width: 100%;
	}
	.sources {
		justify-content: flex-start;
		flex-wrap: wrap;
	}
	.online {
		font-size: 13px;
	}
	.review {
		overflow: auto;
		min-height: 80px;
	}
	.review article {
		padding: 16px 0;
		border-top: 1px solid #8884;
	}
	.original {
		display: flex;
		gap: 10px;
		align-items: center;
		flex-wrap: wrap;
		font-size: 12px;
	}
	.match {
		display: grid;
		gap: 8px;
		font-size: 12px;
		margin-top: 14px;
	}
	.match select {
		padding: 10px;
		border: 1px solid var(--sonora-border-strong);
		color: inherit;
		background: var(--sonora-bg-elevated);
		border-radius: 7px;
		width: 100%;
	}
	details {
		margin-top: 12px;
		font-size: 12px;
	}
	summary {
		cursor: pointer;
	}
	.original strong {
		overflow-wrap: anywhere;
	}
	.original span {
		opacity: 0.7;
	}
	.fields {
		display: grid;
		grid-template-columns: 2fr 1.3fr 1fr;
		gap: 14px;
		margin-top: 12px;
	}
	.fields label {
		display: grid;
		gap: 6px;
		font-size: 12px;
	}
	.fields input {
		border: 1px solid #8885;
		border-radius: 7px;
		padding: 10px;
		color: inherit;
		background: transparent;
		width: 100%;
		box-sizing: border-box;
	}
	footer {
		border-top: 1px solid #8884;
		padding-top: 16px;
		font-size: 12px;
	}
	footer button {
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
	}
	.batch {
		justify-content: flex-start;
		font-size: 12px;
	}
	@media (max-width: 650px) {
		.fields {
			grid-template-columns: 1fr;
		}
		header,
		footer {
			align-items: flex-start;
			flex-direction: column;
		}
		.import-backdrop {
			padding: 10px;
		}
	}
</style>
