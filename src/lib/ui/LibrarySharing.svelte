<script lang="ts">
	import { onMount } from 'svelte';
	import { db } from '../db';
	import { Download, Upload, Loader2 } from '@lucide/svelte';
	import { exportCompleteLibrary, importLibrary } from '../libraryArchive';
	import { chooseAndAddFolder } from '../folderSync';
	import { isTauri } from '../paths';
	import TextButton from './TextButton.svelte';
	let {
		libraryRoot,
		scoreCount,
		onImported
	}: {
		libraryRoot?: string | null;
		scoreCount: number;
		onImported?: () => Promise<void>;
	} = $props();
	let availableScores = $state(0);
	onMount(() => {
		void db.scores.count().then((count) => (availableScores = count));
	});
	let busy = $state(false),
		status = $state(''),
		error = $state('');
	async function run(kind: 'export' | 'import') {
		busy = true;
		error = '';
		status =
			kind === 'export'
				? 'Preparing PDFs, annotations, and lists…'
				: 'Choose a Sonora library ZIP…';
		try {
			if (kind === 'export') {
				const path = await exportCompleteLibrary();
				status = path
					? `Complete library saved to ${path}`
					: 'Export cancelled.';
			} else {
				const root =
					libraryRoot ||
					(await db.folders.get('library-root'))?.nativePath ||
					(await chooseAndAddFolder()).nativePath;
				if (!root) throw new Error('Choose a desktop library folder first.');
				const result = await importLibrary(root);
				if (result) {
					await onImported?.();
					status = `Imported ${result.scores} scores and ${result.lists} lists, with annotations.`;
				} else status = 'Import cancelled.';
			}
		} catch (e) {
			status = '';
			if ((e as DOMException)?.name !== 'AbortError') error = String(e);
		} finally {
			busy = false;
		}
	}
</script>

<div class="sharing">
	<p>
		Share your complete library as one ZIP: original PDFs, editable annotations,
		score metadata, and ordered lists.
	</p>
	<div class="actions">
		<TextButton
			primary
			disabled={busy || !(scoreCount || availableScores) || !isTauri()}
			onclick={() => void run('export')}
			><Download size={16} /> Export complete library</TextButton
		><TextButton
			disabled={busy || !isTauri()}
			onclick={() => void run('import')}
			><Upload size={16} /> Import library</TextButton>
	</div>
	<p class="hint">
		Imports add a separate folder and preserve existing scores. Recipients can
		use Import library in Sonora; PDFs are also accessible with any ZIP reader.
	</p>
	{#if busy}<p class="status" role="status">
			<Loader2 size={16} class="spin" />{status}
		</p>{:else if status}<p class="status" role="status">{status}</p>{/if}
	{#if error}<p class="error" role="alert">{error}</p>{/if}
</div>

<style>
	p {
		font-size: var(--sonora-text-sm);
		line-height: 1.6;
		color: var(--sonora-text-secondary);
		margin: 0 0 12px;
	}
	.hint {
		color: var(--sonora-text-muted);
		margin-top: 12px;
	}
	.actions {
		display: flex;
		gap: 8px;
		flex-wrap: wrap;
	}
	.status {
		display: flex;
		gap: 8px;
		align-items: center;
		overflow-wrap: anywhere;
		color: var(--sonora-accent);
	}
	.error {
		color: var(--sonora-danger);
		overflow-wrap: anywhere;
	}
	:global(.sharing .spin) {
		animation: spin 1s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
