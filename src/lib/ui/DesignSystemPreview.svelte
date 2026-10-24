<script lang="ts">
	import { Music2 } from '@lucide/svelte';
	import TextButton from './TextButton.svelte';
	import IconButton from './IconButton.svelte';
	import Toggle from './Toggle.svelte';
	import SearchField from './SearchField.svelte';
	import SegmentedControl from './SegmentedControl.svelte';
	let selected = $state('score');
	let checked = $state(true);
	let search = $state('');
</script>

<details class="specimens">
	<summary>Design system · The engraved library</summary>
	<div class="samples">
		<h2>Music, collected.</h2>
		<p>Warm paper, expressive serif type, quiet borders, and ink accents.</p>
		<div class="swatches" aria-label="Semantic colors">
			<span>Paper</span><span>Ink</span><span>Accent</span>
		</div>
		<div class="controls">
			<TextButton>Default</TextButton><TextButton primary>Primary</TextButton
			><TextButton disabled>Disabled</TextButton><IconButton
				ariaLabel="Example music icon"><Music2 size={18} /></IconButton>
		</div>
		<SearchField
			bind:value={search}
			placeholder="Search the collection"
			ariaLabel="Design system search example" />
		<SegmentedControl
			bind:value={selected}
			options={[
				{ value: 'score', label: 'Scores' },
				{ value: 'parts', label: 'Parts' }
			]}
			ariaLabel="Design system segment example" />
		<label class="example-toggle"
			>Example preference<Toggle
				{checked}
				ariaLabel="Example preference"
				onchange={(v) => (checked = v)} /></label>
		<p class="feedback" role="status">
			Every control follows your theme, accent, and density.
		</p>
	</div>
</details>

<style>
	.specimens {
		margin-top: 16px;
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-md);
	}
	summary {
		padding: var(--sonora-space);
		cursor: pointer;
		font-size: var(--sonora-text-sm);
		color: var(--sonora-text-secondary);
	}
	.samples {
		display: grid;
		gap: var(--sonora-space);
		padding: var(--sonora-space);
		border-top: 1px solid var(--sonora-border);
	}
	h2,
	p {
		margin: 0;
	}
	h2 {
		font-size: var(--sonora-text-2xl);
	}
	p {
		font-size: var(--sonora-text-sm);
		line-height: 1.6;
		color: var(--sonora-text-muted);
	}
	.controls {
		display: flex;
		gap: var(--sonora-gap-md);
		flex-wrap: wrap;
	}
	.swatches {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		border: 1px solid var(--sonora-border-strong);
		border-radius: var(--sonora-radius-sm);
		overflow: hidden;
	}
	.swatches span {
		padding: 16px 4px;
		text-align: center;
		background: var(--sonora-surface-raised);
		color: var(--sonora-text);
		font-size: var(--sonora-text-sm);
	}
	.swatches span:nth-child(2) {
		background: var(--sonora-text);
		color: var(--sonora-bg);
	}
	.swatches span:nth-child(3) {
		background: var(--sonora-accent);
		color: var(--sonora-accent-contrast);
	}
	.example-toggle {
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: var(--sonora-text-sm);
	}
	.feedback {
		padding: var(--sonora-space);
		background: var(--sonora-accent-soft);
		border-left: 2px solid var(--sonora-accent);
	}
</style>
