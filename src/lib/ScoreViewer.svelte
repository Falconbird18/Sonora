<script lang="ts">
	// TEMPORARY STUB — restoring full file next
	let { score, onClose }: { score: any; onClose: () => void } = $props();
</script>

<div class="viewer-stub">
	<p>Score viewer is being restored…</p>
	<button type="button" onclick={onClose}>Back</button>
</div>

<style>
	.viewer-stub {
		display: grid;
		place-items: center;
		height: 100%;
		gap: 12px;
		color: var(--sonora-text, #f5f5f4);
		background: var(--sonora-bg, #0c0c0e);
	}
	button {
		padding: 10px 16px;
		border-radius: 10px;
		border: 1px solid rgba(255, 255, 255, 0.12);
		background: #1c1c19;
		color: inherit;
		cursor: pointer;
	}
</style>
