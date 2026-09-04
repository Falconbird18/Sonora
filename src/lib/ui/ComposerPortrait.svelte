<script lang="ts">
	type Props = {
		name: string;
		src?: string | null;
		size?: 'sm' | 'md';
		class?: string;
	};

	let { name, src = null, size = 'sm', class: className = '' }: Props = $props();

	const initials = $derived(
		name
			.split(/\s+/)
			.filter(Boolean)
			.slice(0, 2)
			.map((part) => part[0])
			.join('')
			.toUpperCase() || '?'
	);
</script>

<div class="portrait {className}" class:md={size === 'md'} title={name} aria-hidden="true">
	{#if src}
		<img {src} alt="" loading="lazy" decoding="async" />
	{:else}
		<span>{initials}</span>
	{/if}
</div>

<style>
	.portrait {
		position: relative;
		flex: 0 0 28px;
		width: 28px;
		height: 28px;
		display: grid;
		place-items: center;
		overflow: hidden;
		border: 1px solid var(--sonora-border-strong);
		border-radius: 8px;
		background: linear-gradient(145deg, #252521 0%, #1a1a17 100%);
		color: var(--sonora-text-muted);
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.02em;
		box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.04);
	}
	.portrait.md {
		flex-basis: 36px;
		width: 36px;
		height: 36px;
		border-radius: 10px;
		font-size: 11px;
	}
	img {
		position: absolute;
		inset: 0;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}
</style>
