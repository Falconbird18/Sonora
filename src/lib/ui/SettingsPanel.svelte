<script lang="ts">
	import { Monitor, Moon, Sun, X } from '@lucide/svelte';
	import { fade, fly } from 'svelte/transition';
	import { settings, type ThemePreference } from '../settingsStore';
	import Toggle from './Toggle.svelte';

	type Props = {
		open?: boolean;
		onClose: () => void;
	};

	let { open = false, onClose }: Props = $props();

	const themes: { value: ThemePreference; label: string; icon: 'system' | 'dark' | 'light' }[] = [
		{ value: 'system', label: 'System', icon: 'system' },
		{ value: 'dark', label: 'Dark', icon: 'dark' },
		{ value: 'light', label: 'Light', icon: 'light' }
	];

	function onKey(event: KeyboardEvent) {
		if (event.key === 'Escape' && open) onClose();
	}
</script>

<svelte:window onkeydown={onKey} />

{#if open}
	<!-- svelte-ignore a11y_click_events_have_key_events a11y_no_static_element_interactions -->
	<div
		class="backdrop"
		role="presentation"
		onclick={(e) => {
			if (e.currentTarget === e.target) onClose();
		}}
		transition:fade={{ duration: 200 }}
	>
		<div
			class="panel"
			role="dialog"
			aria-modal="true"
			aria-labelledby="settings-title"
			transition:fly={{ y: 20, duration: 320, opacity: 0 }}
		>
			<header class="panel-header">
				<div>
					<h2 id="settings-title">Settings</h2>
					<p>Appearance and library preferences</p>
				</div>
				<button type="button" class="close" onclick={onClose} aria-label="Close settings">
					<X size={18} strokeWidth={2} />
				</button>
			</header>

			<section class="section">
				<h3>Theme</h3>
				<div class="theme-grid" role="radiogroup" aria-label="Color theme">
					{#each themes as theme}
						<button
							type="button"
							class="theme-card"
							class:active={$settings.theme === theme.value}
							role="radio"
							aria-checked={$settings.theme === theme.value}
							onclick={() => settings.setTheme(theme.value)}
						>
							<span class="theme-icon" aria-hidden="true">
								{#if theme.icon === 'system'}
									<Monitor size={18} strokeWidth={2} />
								{:else if theme.icon === 'dark'}
									<Moon size={18} strokeWidth={2} />
								{:else}
									<Sun size={18} strokeWidth={2} />
								{/if}
							</span>
							<span class="theme-label">{theme.label}</span>
						</button>
					{/each}
				</div>
			</section>

			<section class="section">
				<h3>Experience</h3>
				<div class="rows">
					<label class="row">
						<div class="row-copy">
							<strong>Reduce motion</strong>
							<span>Minimize animations and transitions</span>
						</div>
						<Toggle
							checked={$settings.reduceMotion}
							ariaLabel="Reduce motion"
							onchange={(v) => settings.setReduceMotion(v)}
						/>
					</label>
					<label class="row">
						<div class="row-copy">
							<strong>Compact library</strong>
							<span>Tighter spacing for score cards</span>
						</div>
						<Toggle
							checked={$settings.compactLibrary}
							ariaLabel="Compact library"
							onchange={(v) => settings.setCompactLibrary(v)}
						/>
					</label>
				</div>
			</section>

			<footer class="panel-footer">
				<button type="button" class="ghost" onclick={() => settings.reset()}>Reset defaults</button>
				<button type="button" class="done" onclick={onClose}>Done</button>
			</footer>
		</div>
	</div>
{/if}

<style>
	.backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		display: grid;
		place-items: center;
		padding: 24px;
		background: rgba(6, 6, 10, 0.55);
		backdrop-filter: blur(8px);
		-webkit-backdrop-filter: blur(8px);
	}
	.panel {
		width: min(440px, 100%);
		max-height: min(90dvh, 640px);
		overflow: auto;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-2xl);
		background: var(--sonora-bg-panel-solid);
		box-shadow: var(--sonora-shadow-lg);
		display: flex;
		flex-direction: column;
	}
	.panel-header {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 12px;
		padding: 22px 22px 16px;
		border-bottom: 1px solid var(--sonora-border);
	}
	.panel-header h2 {
		margin: 0;
		font-size: var(--sonora-text-xl);
		font-weight: 650;
		letter-spacing: var(--sonora-tracking-tight);
		color: var(--sonora-text);
	}
	.panel-header p {
		margin: 4px 0 0;
		font-size: var(--sonora-text-sm);
		color: var(--sonora-text-muted);
	}
	.close {
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border: 0;
		border-radius: var(--sonora-radius-md);
		background: transparent;
		color: var(--sonora-text-muted);
		cursor: pointer;
		transition:
			background var(--sonora-duration) var(--sonora-ease),
			color var(--sonora-duration) var(--sonora-ease);
	}
	.close:hover {
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
	}
	.section {
		padding: 18px 22px;
		border-bottom: 1px solid var(--sonora-border);
	}
	.section h3 {
		margin: 0 0 12px;
		font-size: var(--sonora-text-xs);
		font-weight: 650;
		letter-spacing: var(--sonora-tracking-wide);
		text-transform: uppercase;
		color: var(--sonora-text-faint);
	}
	.theme-grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 10px;
	}
	.theme-card {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: 8px;
		padding: 14px 10px;
		border: 1px solid var(--sonora-border);
		border-radius: var(--sonora-radius-lg);
		background: var(--sonora-bg-elevated);
		color: var(--sonora-text-muted);
		cursor: pointer;
		transition:
			background var(--sonora-duration) var(--sonora-ease),
			border-color var(--sonora-duration) var(--sonora-ease),
			color var(--sonora-duration) var(--sonora-ease),
			box-shadow var(--sonora-duration) var(--sonora-ease),
			transform var(--sonora-duration) var(--sonora-ease);
	}
	.theme-card:hover {
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
		border-color: var(--sonora-border-strong);
		transform: translateY(-1px);
	}
	.theme-card.active {
		border-color: color-mix(in srgb, var(--sonora-accent) 55%, transparent);
		background: var(--sonora-accent-soft);
		color: var(--sonora-text);
		box-shadow: 0 0 0 1px color-mix(in srgb, var(--sonora-accent) 25%, transparent);
	}
	.theme-icon {
		width: 36px;
		height: 36px;
		display: grid;
		place-items: center;
		border-radius: 12px;
		background: var(--sonora-bg-deep);
		border: 1px solid var(--sonora-border);
	}
	.theme-card.active .theme-icon {
		background: var(--sonora-accent);
		border-color: transparent;
		color: var(--sonora-accent-contrast);
		box-shadow: var(--sonora-accent-glow);
	}
	.theme-label {
		font-size: var(--sonora-text-sm);
		font-weight: 600;
	}
	.rows {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}
	.row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 16px;
		padding: 12px 10px;
		border-radius: var(--sonora-radius-md);
		cursor: pointer;
		transition: background var(--sonora-duration) var(--sonora-ease);
	}
	.row:hover {
		background: var(--sonora-bg-hover);
	}
	.row-copy {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}
	.row-copy strong {
		font-size: var(--sonora-text-md);
		font-weight: 600;
		color: var(--sonora-text);
	}
	.row-copy span {
		font-size: var(--sonora-text-sm);
		color: var(--sonora-text-muted);
	}
	.panel-footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 14px 22px;
		margin-top: auto;
	}
	.ghost,
	.done {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		padding: 9px 14px;
		border-radius: var(--sonora-radius-md);
		font-size: var(--sonora-text-sm);
		font-weight: 600;
		cursor: pointer;
		transition:
			background var(--sonora-duration) var(--sonora-ease),
			color var(--sonora-duration) var(--sonora-ease),
			border-color var(--sonora-duration) var(--sonora-ease);
	}
	.ghost {
		border: 1px solid transparent;
		background: transparent;
		color: var(--sonora-text-muted);
	}
	.ghost:hover {
		background: var(--sonora-bg-hover);
		color: var(--sonora-text);
	}
	.done {
		border: 1px solid transparent;
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
		box-shadow: var(--sonora-accent-glow);
	}
	.done:hover {
		background: var(--sonora-accent-hover);
	}
</style>
