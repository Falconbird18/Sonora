<script lang="ts">
	import { onMount } from 'svelte';
	import { db } from './lib/db';
	import { resolveScoreSource } from './lib/folderSync';
	import type { ScoreItem, ScoreList } from './lib/types';
	import type { Component } from 'svelte';
	import { settings } from './lib/settingsStore';

	let activeScore = $state<ScoreItem | null>(null);
	let program = $state<{ list: ScoreList; entryId: string } | null>(null);
	const programIndex = $derived(
		program?.list.entries.findIndex((entry) => entry.id === program?.entryId) ??
			-1
	);
	const programLabel = $derived(
		program
			? `${program.list.name} · ${programIndex + 1} / ${program.list.entries.length}`
			: ''
	);
	let programError = $state('');
	async function navigateProgram(direction: number) {
		if (!program) return;
		const entry = program.list.entries[programIndex + direction];
		if (!entry) return;
		const score = await db.scores.get(entry.scoreId);
		if (!score) {
			programError =
				'This program item is no longer in the library. Return to your list to choose another score.';
			return;
		}
		const folder = await db.folders.get('library-root');
		const source = resolveScoreSource(score, folder);
		programError = '';
		program = { ...program, entryId: entry.id };
		activeScore = {
			...score,
			pdfUrl: source.url || score.pdfUrl,
			nativePath: source.nativePath || score.nativePath,
			pdfBlob: source.blob || score.pdfBlob
		};
		await db.scores.update(score.id, { lastOpenedAt: Date.now() });
	}
	let crash = $state('');
	let libraryView = $state<Component<any> | null>(null);
	let libraryViewError = $state('');
	let scoreViewer = $state<Component<any> | null>(null);
	let scoreViewerError = $state('');

	onMount(() => {
		void settings;
		void loadLibraryView();
		const warmup = setTimeout(() => {
			void loadScoreViewer();
			void import('./lib/pdfUtils')
				.then(({ warmPdfRenderer }) => warmPdfRenderer())
				.catch((error) => console.warn('PDF warmup deferred', error));
		}, 300);
		return () => clearTimeout(warmup);
	});

	async function loadLibraryView() {
		try {
			const module = await import('./lib/LibraryView.svelte');
			libraryView = module.default;
		} catch (reason) {
			console.error('Sonora library failed to load', reason);
			libraryViewError =
				reason instanceof Error ? reason.message : String(reason);
		}
	}

	async function loadScoreViewer() {
		if (scoreViewer || scoreViewerError) return;
		try {
			const module = await import('./lib/ScoreViewer.svelte');
			scoreViewer = module.default;
		} catch (reason) {
			console.error('Sonora score viewer failed to load', reason);
			scoreViewerError =
				reason instanceof Error ? reason.message : String(reason);
		}
	}

	function closeScore() {
		const finish = () => {
			activeScore = null;
			program = null;
			programError = '';
			crash = '';
		};
		if (typeof document !== 'undefined' && document.fullscreenElement) {
			void document.exitFullscreen().then(finish).catch(finish);
			return;
		}
		finish();
	}

	function onWindowError(event: Event) {
		const errorEvent = event instanceof ErrorEvent ? event : null;
		const error = errorEvent?.error || errorEvent?.message || event;
		console.error('Sonora error', error);
	}

	function onUnhandled(event: PromiseRejectionEvent) {
		console.error('Sonora unhandled rejection', event.reason);
		const message =
			event.reason instanceof Error
				? event.reason.message
				: String(event.reason || '');
		if (activeScore && /pdf|canvas|worker/i.test(message)) {
			crash = 'The score renderer hit a snag. Returning to your library.';
			closeScore();
		}
	}

	async function openScore(
		score: ScoreItem,
		context?: { listId: string; entryId: string }
	) {
		const list = context ? await db.lists.get(context.listId) : undefined;
		program = list && context ? { list, entryId: context.entryId } : null;
		programError = '';
		activeScore = score;
		crash = '';
		scoreViewerError = '';
		void loadScoreViewer();
	}
</script>

<svelte:head>
	<meta
		name="viewport"
		content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content" />
	<meta name="theme-color" content="#0c0c0e" />
</svelte:head>

<svelte:window onerror={onWindowError} onunhandledrejection={onUnhandled} />

<main class="app-shell">
	<div class="layer" class:hidden={!!activeScore} inert={!!activeScore}>
		{#if libraryView}
			{@const Library = libraryView}
			<Library paused={!!activeScore} onSelectScore={openScore} />
		{:else if libraryViewError}
			<div class="startup-error">
				<strong>Sonora could not load the library.</strong>
				<p>{libraryViewError}</p>
			</div>
		{:else}
			<div class="startup-loading">
				<span></span><strong>Starting Sonora…</strong>
			</div>
		{/if}
	</div>

	{#if activeScore}
		<div class="layer viewer-layer">
			{#if scoreViewer}
				{@const Viewer = scoreViewer}
				{#key `${activeScore.id}:${program?.entryId ?? ''}`}
					<Viewer
						score={activeScore}
						onClose={closeScore}
						sequenceLabel={programLabel}
						onPreviousScore={programIndex > 0
							? () => navigateProgram(-1)
							: undefined}
						onNextScore={program &&
						programIndex < program.list.entries.length - 1
							? () => navigateProgram(1)
							: undefined} />
				{/key}
				{#if programError}<div class="program-error" role="alert">
						{programError}
					</div>{/if}
			{:else if scoreViewerError}
				<div class="viewer-error">
					<strong>Sonora could not load the score viewer.</strong>
					<p>{scoreViewerError}</p>
					<button onclick={closeScore}>Return to library</button>
				</div>
			{:else}
				<div class="viewer-loading">
					<span></span><strong>Preparing score viewer…</strong>
				</div>
			{/if}
		</div>
	{/if}
	{#if crash}
		<div class="crash">{crash}</div>
	{/if}
</main>

<style>
	.program-error {
		position: absolute;
		top: 70px;
		left: 20px;
		right: 20px;
		z-index: 100;
		padding: 14px;
		border: 1px solid var(--sonora-danger);
		border-radius: var(--sonora-radius-md);
		background: var(--sonora-bg-panel-solid);
		color: var(--sonora-danger);
	}
	:global(html),
	:global(body),
	:global(#app) {
		margin: 0;
		width: 100%;
		height: 100%;
		overflow: hidden;
	}
	:global(html) {
		background: var(--sonora-bg, #0c0c0e);
	}
	:global(button),
	:global(input),
	:global(select),
	:global(textarea) {
		font: inherit;
	}
	:global(button),
	:global(label) {
		-webkit-tap-highlight-color: transparent;
	}
	:global(button) {
		touch-action: manipulation;
	}
	:global(img) {
		-webkit-user-drag: none;
	}
	:global(.app-shell *) {
		box-sizing: border-box;
	}
	.app-shell {
		isolation: isolate;
		position: relative;
		width: 100%;
		height: 100%;
		min-height: 100dvh;
		background: var(--sonora-bg);
		color: var(--sonora-text);
		overflow: hidden;
		padding-top: env(safe-area-inset-top);
		padding-bottom: env(safe-area-inset-bottom);
	}
	.layer {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
	}
	.layer.hidden {
		visibility: hidden;
		pointer-events: none;
	}
	.startup-loading,
	.startup-error {
		width: min(680px, calc(100% - 48px));
		margin: auto;
		display: grid;
		place-items: center;
		align-content: center;
		gap: 12px;
		height: 100%;
		text-align: center;
		color: var(--sonora-text);
	}
	.startup-loading span {
		width: 20px;
		height: 20px;
		border: 2px solid var(--sonora-border-strong);
		border-top-color: var(--sonora-accent);
		border-radius: 50%;
		animation: spin 0.75s linear infinite;
	}
	.startup-error p {
		max-width: 620px;
		margin: 0;
		color: var(--sonora-text-secondary);
		overflow-wrap: anywhere;
	}
	.startup-error strong {
		font-size: 1.05rem;
	}
	.viewer-layer {
		z-index: 10;
		background: var(--sonora-bg);
	}
	.viewer-error {
		width: min(680px, calc(100% - 48px));
		margin: auto;
		display: grid;
		place-items: center;
		align-content: center;
		gap: 12px;
		height: 100%;
		text-align: center;
		color: var(--sonora-text);
	}
	.viewer-error p {
		max-width: 620px;
		margin: 0;
		color: var(--sonora-text-secondary);
		overflow-wrap: anywhere;
	}
	.viewer-error button {
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md, 12px);
		padding: 9px 14px;
		background: var(--sonora-surface-raised);
		color: inherit;
		cursor: pointer;
	}
	.viewer-error button:hover {
		background: var(--sonora-bg-hover);
	}
	.viewer-loading {
		width: 100%;
		height: 100%;
		display: grid;
		place-items: center;
		align-content: center;
		gap: 12px;
		color: var(--sonora-text);
	}
	.viewer-loading span {
		width: 20px;
		height: 20px;
		border: 2px solid var(--sonora-border-strong);
		border-top-color: var(--sonora-accent);
		border-radius: 50%;
		animation: spin 0.75s linear infinite;
	}
	.crash {
		position: absolute;
		z-index: 40;
		left: 50%;
		top: 18px;
		transform: translateX(-50%);
		padding: 8px 12px;
		border-radius: 8px;
		background: var(--sonora-warning-soft);
		border: 1px solid color-mix(in srgb, var(--sonora-warning) 35%, transparent);
		color: var(--sonora-text);
		font-size: 0.82rem;
	}
	@media (pointer: coarse) {
		:global(button) {
			min-width: 40px;
			min-height: 40px;
		}
		:global(input),
		:global(select) {
			min-height: 40px;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		.viewer-loading span,
		.startup-loading span {
			animation: none;
		}
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
