<script lang="ts">
	import { getImslpThumbnail } from '../imslpThumbnails';
	import { Music2 } from '@lucide/svelte';
	let {
		url,
		label = 'Score preview'
	}: { url?: string | null; label?: string } = $props();
	let source = $state('');
	let failed = $state(false);
	$effect(() => {
		const requested = url;
		let active = true;
		source = '';
		failed = false;
		if (requested)
			getImslpThumbnail(requested)
				.then((value) => {
					if (active) source = value;
				})
				.catch(() => {
					if (active) failed = true;
				});
		return () => {
			active = false;
		};
	});
</script>

<div class="preview" aria-label={label}>
	{#if source && !failed}<img
			src={source}
			alt={label}
			onerror={() => (failed = true)} />
	{:else}<Music2 size={24} /><span
			>{failed
				? 'Preview unavailable'
				: url
					? 'Loading preview…'
					: 'No preview'}</span
		>{/if}
</div>

<style>
	.preview {
		width: 100%;
		height: 100%;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-direction: column;
		gap: 8px;
		background: var(--sonora-bg-deep);
		color: var(--sonora-text-muted);
		overflow: hidden;
	}
	img {
		width: 100%;
		height: 100%;
		object-fit: contain;
		object-position: top;
		background: #fff;
	}
	span {
		font-size: 11px;
		text-align: center;
	}
</style>
