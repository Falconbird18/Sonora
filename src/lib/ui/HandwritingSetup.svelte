<script lang="ts">
	import { untrack } from 'svelte';
	import {
		Download,
		X,
		Check,
		ShieldCheck,
		PenLine,
		AlertCircle
	} from '@lucide/svelte';
	import { dialogFocus } from './dialogFocus';
	import {
		prepareHandwritingModels,
		type ModelPreparationProgress
	} from '../handwriting';
	let {
		open = $bindable(false),
		pauseMs,
		onPauseChange,
		onReady
	}: {
		open?: boolean;
		pauseMs: number;
		onPauseChange: (ms: number) => void;
		onReady: () => void;
	} = $props();
	let dialog: HTMLDialogElement;
	let preparing = $state(false);
	let ready = $state(false);
	let error = $state('');
	let progress = $state<ModelPreparationProgress>({
		status: 'Loading built-in recognition…'
	});
	const percent = $derived(
		ready
			? 100
			: progress.total && progress.completed != null
				? Math.min(100, Math.floor((progress.completed / progress.total) * 100))
				: undefined
	);
	const stage = $derived(
		ready
			? 'Ready to write'
			: progress.status.startsWith('pulling ') && progress.total
				? 'Loading recognition models'
				: progress.status === 'pulling manifest'
					? 'Preparing recognition'
					: progress.status
	);
	const bytes = (value: number) =>
		value >= 1e9
			? `${(value / 1e9).toFixed(2)} GB`
			: `${(value / 1e6).toFixed(1)} MB`;
	$effect(() => {
		if (!dialog) return;
		if (open && !dialog.open) dialog.showModal();
		else if (!open && dialog.open) dialog.close();
	});
	$effect(() => {
		if (open)
			untrack(() => {
				void prepare();
			});
	});
	async function prepare() {
		if (preparing) return;
		preparing = true;
		error = '';
		ready = false;
		progress = { status: 'Loading built-in recognition…' };
		try {
			await prepareHandwritingModels((update) => {
				progress = update;
			});
			ready = true;
			onReady();
		} catch (cause) {
			error = String(cause);
		} finally {
			preparing = false;
		}
	}
</script>

<dialog
	bind:this={dialog}
	class="handwriting-modal"
	aria-labelledby="handwriting-title"
	oncancel={(event) => {
		event.preventDefault();
		open = false;
	}}>
	{#if open}
		<div class="modal-content" use:dialogFocus>
			<button
				class="close"
				aria-label="Close handwriting setup"
				onclick={() => (open = false)}><X size={19} /></button>
			<div class="hero-icon"><PenLine size={27} strokeWidth={1.6} /></div>
			<p class="eyebrow">HANDWRITING IN SONORA</p>
			<h2 id="handwriting-title">
				{ready ? 'Your pen is ready.' : 'From ink to notation.'}
			</h2>
			<p class="intro">
				Write symbols and text directly on your score. Pause for a moment, and
				Sonora turns your ink into marks you can move.
			</p>
			<div class="model-card">
				<div class="model-heading">
					<span class="download-icon"
						>{#if ready}<Check size={20} />{:else}<Download
								size={20} />{/if}</span>
					<div>
						<strong>Built-in handwriting models</strong><span
							>Music symbols + handwritten text</span>
					</div>
					<span class="size">5.6 MB</span>
				</div>
				{#if preparing || ready || error}
					<div class="download-details">
						<div class="progress-heading">
							<span role="status"
								>{error ? 'Could not prepare recognition' : stage}</span
							>{#if percent !== undefined && !error}<strong>{percent}%</strong
								>{/if}
						</div>
						<progress
							aria-label="Recognition preparation progress"
							max="100"
							value={percent}
							class:complete={ready}
							class:failed={!!error}></progress>
						<p class="transfer">
							{#if error}Your ink is preserved. Try preparing the engine again.{:else if ready}Ready.
								Handwriting works entirely on this device.{:else if progress.total && progress.completed != null}{bytes(
									progress.completed
								)} of {bytes(progress.total)} · built-in models{:else}Preparing
								the local engine. You can keep using Sonora.{/if}
						</p>
					</div>
				{:else}
					<p class="model-description">
						Included with Sonora. No model server, account, or separate download
						is needed.
					</p>
				{/if}
			</div>
			{#if error}<div class="error" role="alert">
					<AlertCircle size={18} /><span>{error}</span>
				</div>{/if}
			<div class="support-note">
				Auto recognizes common music marks and text. Use Music symbols or Text
				for ambiguous handwriting. Uncertain marks stay as ink.
			</div>
			<div class="privacy">
				<ShieldCheck size={17} /><span
					>Your handwriting stays on this device. No account or cloud
					recognition.</span>
			</div>
			<div class="writing-pace">
				<label for="handwriting-pause"
					>Pause before conversion <strong
						>{(pauseMs / 1000).toFixed(1)} seconds</strong
					></label>
				<input
					id="handwriting-pause"
					type="range"
					min="1000"
					max="5000"
					step="250"
					value={pauseMs}
					oninput={(event) =>
						onPauseChange(Number(event.currentTarget.value))} />
				<p>
					Short breaks between strokes are ignored. Every stroke restarts the
					wait, so you can finish a whole word before it converts.
				</p>
			</div>

			<footer>
				<button class="secondary" onclick={() => (open = false)}
					>{preparing
						? 'Continue in background'
						: ready
							? 'Close'
							: 'Maybe later'}</button
				><button
					class="primary"
					disabled={preparing}
					onclick={() => (ready ? (open = false) : prepare())}
					>{#if ready}<Check size={16} />Start writing{:else if preparing}Preparing…{:else}<Download
							size={16} />{error
							? 'Retry preparation'
							: 'Prepare recognition'}{/if}</button>
			</footer>
		</div>
	{/if}
</dialog>

<style>
	.handwriting-modal {
		width: min(480px, calc(100vw - 32px));
		max-height: calc(100dvh - 40px);
		padding: 0;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 22px;
		background: var(--sonora-bg-panel-solid);
		color: var(--sonora-text);
		box-shadow: 0 24px 100px #0008;
		font-family: var(--sonora-font-ui, system-ui, sans-serif);
		overflow: auto;
	}
	.handwriting-modal::backdrop {
		background: #080705a8;
		backdrop-filter: blur(7px);
	}
	.modal-content {
		padding: 24px;
		position: relative;
	}
	.close {
		position: absolute;
		top: 16px;
		right: 16px;
		border: 0;
		background: transparent;
		color: var(--sonora-text-muted);
		padding: 7px;
		border-radius: 8px;
		cursor: pointer;
		display: grid;
		place-items: center;
	}
	.close:hover {
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
	}
	.hero-icon {
		width: 46px;
		height: 46px;
		display: grid;
		place-items: center;
		background: var(--sonora-accent-soft);
		color: var(--sonora-accent);
		border: 1px solid var(--sonora-border-strong);
		border-radius: 16px;
		margin-bottom: 16px;
	}
	.eyebrow {
		margin: 0 0 8px;
		color: var(--sonora-accent);
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.14em;
	}
	h2 {
		font-family: Georgia, serif;
		font-weight: 500;
		font-size: 28px;
		line-height: 1.15;
		margin: 0 0 12px;
		letter-spacing: -0.025em;
	}
	.intro {
		font-size: 14px;
		line-height: 1.55;
		color: var(--sonora-text-muted);
		margin: 0 0 16px;
	}
	.model-card {
		border: 1px solid var(--sonora-border-strong);
		border-radius: 13px;
		padding: 16px;
		background: var(--sonora-bg-deep);
	}
	.model-heading {
		display: flex;
		align-items: center;
		gap: 11px;
	}
	.download-icon {
		display: grid;
		place-items: center;
		color: var(--sonora-accent);
		flex-shrink: 0;
	}
	.model-heading div {
		display: grid;
		gap: 4px;
	}
	.model-heading strong {
		font-size: 13px;
		font-weight: 600;
	}
	.model-heading div span,
	.size {
		font-size: 11px;
		color: var(--sonora-text-muted);
	}
	.size {
		margin-left: auto;
		white-space: nowrap;
	}
	.model-description,
	.transfer {
		font-size: 12px;
		line-height: 1.5;
		color: var(--sonora-text-muted);
		margin: 14px 0 0;
	}
	.download-details {
		margin-top: 19px;
	}
	.progress-heading {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		font-size: 12px;
		margin-bottom: 9px;
	}
	.progress-heading span {
		overflow-wrap: anywhere;
	}
	progress {
		appearance: none;
		display: block;
		width: 100%;
		height: 6px;
		border: 0;
		border-radius: 99px;
		overflow: hidden;
		background: var(--sonora-border);
		accent-color: var(--sonora-accent);
	}
	progress::-webkit-progress-bar {
		background: var(--sonora-border);
		border-radius: 99px;
	}
	progress::-webkit-progress-value {
		background: var(--sonora-accent);
		border-radius: 99px;
		transition: width 0.2s ease;
	}
	progress::-moz-progress-bar {
		background: var(--sonora-accent);
		border-radius: 99px;
	}
	progress:indeterminate {
		background: linear-gradient(
			90deg,
			var(--sonora-border) 20%,
			var(--sonora-accent) 50%,
			var(--sonora-border) 80%
		);
		background-size: 200% 100%;
		animation: pending 1.5s linear infinite;
	}
	progress.complete {
		accent-color: var(--sonora-success);
	}
	progress.complete::-webkit-progress-value {
		background: var(--sonora-success);
	}
	progress.failed {
		opacity: 0.45;
		animation: none;
	}
	.transfer {
		margin-top: 9px;
		font-size: 11px;
	}
	.support-note {
		margin-top: 16px;
		color: var(--sonora-text-muted);
		font-size: 12px;
		line-height: 1.6;
	}

	.privacy {
		display: flex;
		gap: 8px;
		margin: 16px 0;
		font-size: 11px;
		line-height: 1.55;
		color: var(--sonora-text-muted);
	}
	.privacy :global(svg),
	.error :global(svg) {
		flex-shrink: 0;
	}
	.error {
		display: flex;
		gap: 8px;
		font-size: 12px;
		line-height: 1.6;
		padding: 12px;
		border-radius: 9px;
		margin-top: 12px;
		background: var(--sonora-danger-soft);
		color: var(--sonora-danger);
	}
	.writing-pace {
		margin: 0 0 16px;
	}
	.writing-pace label {
		display: flex;
		justify-content: space-between;
		gap: 12px;
		font-size: 12px;
		color: var(--sonora-text-secondary);
	}
	.writing-pace strong {
		font-weight: 500;
		color: var(--sonora-accent);
		white-space: nowrap;
	}
	.writing-pace input {
		display: block;
		width: 100%;
		margin: 14px 0;
		accent-color: var(--sonora-accent);
	}
	.writing-pace p {
		margin: 0;
		font-size: 11px;
		line-height: 1.6;
		color: var(--sonora-text-muted);
	}
	footer {
		display: flex;
		justify-content: flex-end;
		gap: 10px;
		padding-top: 16px;
		border-top: 1px solid var(--sonora-border);
	}
	footer button {
		padding: 10px 14px;
		border-radius: 9px;
		min-height: 40px;
		font:
			600 12px system-ui,
			sans-serif;
		display: inline-flex;
		align-items: center;
		justify-content: center;
		gap: 7px;
		cursor: pointer;
	}
	.secondary {
		background: transparent;
		color: var(--sonora-text-muted);
		border: 1px solid var(--sonora-border-strong);
	}
	.primary {
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
		border: 1px solid transparent;
	}
	.primary:disabled {
		opacity: 0.65;
		cursor: wait;
	}
	button:focus-visible {
		outline: 2px solid var(--sonora-accent);
		outline-offset: 3px;
	}
	@keyframes pending {
		to {
			background-position: -200% 0;
		}
	}
	@media (prefers-reduced-motion: reduce) {
		progress:indeterminate {
			animation: none;
		}
	}
	@media (max-width: 440px) {
		.modal-content {
			padding: 24px;
		}
		footer {
			flex-wrap: wrap;
		}
	}
</style>
