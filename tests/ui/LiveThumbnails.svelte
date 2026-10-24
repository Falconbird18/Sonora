<script lang="ts">
	import ImslpThumbnail from '../../src/lib/ui/ImslpThumbnail.svelte';
	import { settings } from '../../src/lib/settingsStore';
	let {
		samples
	}: {
		samples: Array<{ title: string; url: string; data: string; details: any }>;
	} = $props();
	settings.patch({ theme: 'light', accent: 'forest' });
</script>

<main>
	<h1>Live IMSLP image verification</h1>
	<p>
		These are actual native thumbnail payloads from Bach, Mozart, and Debussy.
		Each image must decode in the browser.
	</p>
	<div class="grid">
		{#each samples as sample}<article>
				<div class="image">
					<ImslpThumbnail url={sample.url} label={sample.title} />
				</div>
				<h2>{sample.title}</h2>
				<p>{sample.details.files.length} editions parsed</p>
				<p>{sample.details.metadata.instruments}</p>
			</article>{/each}
	</div>
</main>

<style>
	main {
		max-width: 1100px;
		margin: auto;
		padding: 30px;
	}
	h1 {
		font-size: 28px;
	}
	p {
		color: var(--sonora-text-muted);
		line-height: 1.6;
	}
	.grid {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 20px;
	}
	article {
		padding: 16px;
		background: var(--sonora-surface-raised);
		border: 1px solid var(--sonora-border-strong);
		border-radius: 12px;
		box-shadow: var(--sonora-inset), var(--sonora-shadow-sm);
	}
	.image {
		aspect-ratio: 3/4;
	}
	h2 {
		font-size: 18px;
	}
	@media (max-width: 700px) {
		.grid {
			grid-template-columns: 1fr;
		}
	}
</style>
