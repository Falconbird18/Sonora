<script lang="ts">
	import { onDestroy } from 'svelte';
	import {
		Play,
		Square,
		Minus,
		Plus,
		Hand,
		Mic,
		MicOff,
		Volume2,
		VolumeX
	} from '@lucide/svelte';
	import ViewerPanel from './ViewerPanel.svelte';
	let {
		panel,
		onClose,
		onStateChange
	}: {
		panel: 'metronome' | 'tuner' | null;
		onClose: () => void;
		onStateChange?: (state: { metronome: boolean; tuner: boolean }) => void;
	} = $props();
	let volume = $state(0.6);

	$effect(() => {
		onStateChange?.({ metronome: running, tuner: listening });
	});

	import { detectFrequency, describePitch } from '../pitch';
	let tunerRequest = 0;
	let taps: number[] = [];
	function tapTempo() {
		const now = performance.now();
		taps =
			taps.length && now - taps[taps.length - 1] < 2000
				? [...taps, now].slice(-6)
				: [now];
		if (taps.length > 1)
			bpm = Math.max(
				30,
				Math.min(240, Math.round((60000 * (taps.length - 1)) / (now - taps[0])))
			);
	}
	let bpm = $state(80),
		beats = $state(4),
		beat = $state(0),
		running = $state(false);
	const tempoName = $derived(
		bpm < 60
			? 'Largo'
			: bpm < 76
				? 'Adagio'
				: bpm < 108
					? 'Andante'
					: bpm < 120
						? 'Moderato'
						: bpm < 168
							? 'Allegro'
							: 'Presto'
	);
	let listening = $state(false),
		reference = $state(440),
		note = $state('—'),
		cents = $state(0),
		status = $state('Play a single sustained note');
	let tunerError = $state('');
	let audio: AudioContext | null = null,
		timer: ReturnType<typeof setInterval> | undefined;
	let stream: MediaStream | null = null,
		input: MediaStreamAudioSourceNode | null = null,
		analyser: AnalyserNode | null = null,
		raf = 0,
		nextBeat = 0,
		count = 0,
		disposed = false;
	async function context() {
		audio ??= new AudioContext();
		await audio.resume();
		return audio;
	}
	function stopMetronome() {
		running = false;
		clearInterval(timer);
		nextBeat = 0;
		beat = 0;
	}
	async function toggleMetronome() {
		if (running) {
			stopMetronome();
			return;
		}
		running = true;
		try {
			const ctx = await context();
			if (disposed || !running) return;
			count = 0;
			nextBeat = ctx.currentTime + 0.03;
			timer = setInterval(() => {
				if (nextBeat < ctx.currentTime - 0.2) nextBeat = ctx.currentTime + 0.01;
				while (nextBeat < ctx.currentTime + 0.08) {
					const accent = count % beats === 0;
					const oscillator = ctx.createOscillator(),
						gain = ctx.createGain();
					oscillator.frequency.value = accent ? 1200 : 800;
					gain.gain.setValueAtTime(Math.max(0.0001, 0.3 * volume), nextBeat);
					gain.gain.exponentialRampToValueAtTime(0.001, nextBeat + 0.045);
					oscillator.connect(gain);
					gain.connect(ctx.destination);
					oscillator.start(nextBeat);
					oscillator.stop(nextBeat + 0.05);
					oscillator.onended = () => {
						oscillator.disconnect();
						gain.disconnect();
					};
					beat = (count % beats) + 1;
					count++;
					nextBeat += 60 / Math.max(30, Math.min(240, Number(bpm) || 80));
				}
			}, 25);
		} catch {
			running = false;
			status = 'Audio could not start. Try again.';
		}
	}
	function stopTuner() {
		listening = false;
		tunerRequest++;
		cancelAnimationFrame(raf);
		input?.disconnect();
		input = null;
		analyser = null;
		stream?.getTracks().forEach((t) => t.stop());
		stream = null;
		note = '—';
		cents = 0;
	}
	async function toggleTuner() {
		if (listening) {
			stopTuner();
			return;
		}
		listening = true;
		tunerError = '';
		const request = ++tunerRequest;
		status = 'Requesting microphone…';
		try {
			const captured = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: false,
					noiseSuppression: false,
					autoGainControl: false
				}
			});
			if (disposed || !listening || request !== tunerRequest) {
				captured.getTracks().forEach((t) => t.stop());
				return;
			}
			stream = captured;
			const ctx = await context();
			if (disposed || !listening || request !== tunerRequest) {
				captured.getTracks().forEach((t) => t.stop());
				return;
			}
			analyser = ctx.createAnalyser();
			analyser.fftSize = 4096;
			input = ctx.createMediaStreamSource(stream);
			input.connect(analyser);
			const data = new Float32Array(analyser.fftSize);
			let lastDetection = 0;
			function detect(time = 0) {
				if (!listening || !analyser || request !== tunerRequest) return;
				if (time - lastDetection < 80) {
					raf = requestAnimationFrame(detect);
					return;
				}
				lastDetection = time;
				analyser.getFloatTimeDomainData(data);
				const frequency = detectFrequency(data, ctx.sampleRate);
				if (frequency) {
					const pitch = describePitch(
						frequency,
						Math.max(415, Math.min(466, Number(reference) || 440))
					);
					note = pitch.note;
					cents = pitch.cents;
					status =
						Math.abs(cents) <= 5
							? 'In tune'
							: cents < 0
								? 'Tune higher'
								: 'Tune lower';
				} else {
					note = '—';
					cents = 0;
					status = 'Play a single sustained note';
				}
				raf = requestAnimationFrame(detect);
			}
			detect();
		} catch (error) {
			if (request !== tunerRequest) return;
			stopTuner();
			status = tunerError =
				error instanceof Error ? error.message : 'Microphone unavailable';
		}
	}
	onDestroy(() => {
		disposed = true;
		stopMetronome();
		stopTuner();
		void audio?.close();
	});
</script>

{#if panel === 'metronome'}
	<ViewerPanel title="Metronome" eyebrow="Find your rhythm" {onClose}>
		<div class="metronome-app">
			<div class="tempo-orbit" class:playing={running}>
				<div class="orbit-ring"></div>
				<span class="tempo-word">{tempoName}</span>
				<div class="tempo-number">
					<input
						aria-label="Tempo in beats per minute"
						type="number"
						min="30"
						max="240"
						bind:value={bpm}
						onchange={() =>
							(bpm = Math.max(30, Math.min(240, Number(bpm) || 80)))} /><span
						>BPM</span>
				</div>
				<div class="beat-dots" aria-label={`Beat ${beat} of ${beats}`}>
					{#each Array(beats) as _, i}<i
							class:lit={running && beat === i + 1}
							class:downbeat={i === 0}></i
						>{/each}
				</div>
			</div>
			<div class="tempo-adjust">
				<button
					class="small-icon"
					aria-label="Decrease tempo"
					title="Decrease tempo"
					onclick={() => (bpm = Math.max(30, bpm - 1))}
					><Minus size={16} /></button
				><input
					class="tempo-slider"
					type="range"
					min="30"
					max="240"
					bind:value={bpm}
					aria-label="Tempo" /><button
					class="small-icon"
					aria-label="Increase tempo"
					title="Increase tempo"
					onclick={() => (bpm = Math.min(240, bpm + 1))}
					><Plus size={16} /></button>
			</div>
			<div class="meter-row">
				<span>Beats per bar</span>
				<div class="beat-options" role="group" aria-label="Beats per bar">
					{#each [2, 3, 4, 6] as n}<button
							class:chosen={beats === n}
							aria-pressed={beats === n}
							onclick={() => (beats = n)}>{n}</button
						>{/each}<select
						aria-label="Other beats per bar"
						value={[2, 3, 4, 6].includes(beats) ? '' : beats}
						onchange={(e) => {
							if (e.currentTarget.value) beats = Number(e.currentTarget.value);
						}}
						><option value="" disabled>…</option>{#each [1, 5, 7] as n}<option
								value={n}>{n}</option
							>{/each}</select>
				</div>
			</div>
			<div class="transport">
				<button class="tap-control" onclick={tapTempo} title="Tap tempo"
					><Hand size={18} /><span>Tap tempo</span></button
				><button
					class="play-control"
					class:playing={running}
					onclick={toggleMetronome}
					aria-label={running ? 'Stop metronome' : 'Start metronome'}
					title={running ? 'Stop metronome' : 'Start metronome'}
					>{#if running}<Square size={19} fill="currentColor" />{:else}<Play
							size={22}
							fill="currentColor" />{/if}</button>
				<div class="volume-control">
					<button
						aria-label={volume === 0 ? 'Unmute metronome' : 'Mute metronome'}
						title={volume === 0 ? 'Unmute' : 'Mute'}
						onclick={() => (volume = volume === 0 ? 0.6 : 0)}
						>{#if volume === 0}<VolumeX size={18} />{:else}<Volume2
								size={18} />{/if}</button
					><input
						type="range"
						min="0"
						max="1"
						step=".05"
						bind:value={volume}
						aria-label="Metronome volume" />
				</div>
			</div>
			{#if status.startsWith('Audio could')}<p role="alert">{status}</p>{/if}
		</div>
		<div class="app-footer">
			<span class="status-dot" class:live={running}></span>{running
				? 'Keeping time'
				: 'Ready when you are'}<span class="footer-end">{beats}/4</span>
		</div>
	</ViewerPanel>
{/if}
{#if panel === 'tuner'}
	<ViewerPanel title="Tuner" eyebrow="Find your pitch" {onClose}>
		<div class="tuner-app" class:in-tune={note !== '—' && Math.abs(cents) <= 5}>
			<div class="tuning-status">
				{listening
					? note === '—'
						? 'LISTENING'
						: Math.abs(cents) <= 5
							? 'IN TUNE'
							: cents < 0
								? 'FLAT'
								: 'SHARP'
					: 'CHROMATIC TUNER'}
			</div>
			<div class="note-display">
				{note === '—' ? '—' : note.slice(0, -1)}{#if note !== '—'}<span
						>{note.slice(-1)}</span
					>{/if}
			</div>
			<div class="cents-label">
				{note === '—'
					? 'Play a sustained note'
					: `${cents > 0 ? '+' : ''}${cents} cents`}
			</div>
			<div
				class="pitch-gauge"
				role="meter"
				aria-label="Pitch deviation in cents"
				aria-valuemin={-50}
				aria-valuemax={50}
				aria-valuenow={cents}>
				<div class="gauge-ticks">
					{#each Array(21) as _, i}<i
							class:major={i % 5 === 0}
							class:center={i === 10}></i
						>{/each}
				</div>
				<div class="target-zone"></div>
				<div
					class="needle"
					class:idle={note === '—'}
					style={`--needle:${Math.max(0, Math.min(100, cents + 50))}%`}>
				</div>
			</div>
			<div class="gauge-labels"><span>♭</span><span>0</span><span>♯</span></div>
			<p class="tuner-guidance" role="status">
				{tunerError ||
					(listening ? status : 'Use your microphone to tune any instrument.')}
			</p>
			<button
				class="mic-control"
				class:listening
				onclick={toggleTuner}
				aria-label={listening ? 'Stop tuner' : 'Enable microphone'}
				title={listening ? 'Stop listening' : 'Start listening'}
				>{#if listening}<MicOff size={23} />{:else}<Mic
						size={23} />{/if}</button
			><span class="mic-label"
				>{listening ? 'Stop listening' : 'Start listening'}</span>
		</div>
		<div class="calibration">
			<span>Reference pitch</span><label
				>A4 <input
					aria-label="Reference pitch in Hz"
					type="number"
					min="415"
					max="466"
					bind:value={reference}
					onchange={() =>
						(reference = Math.max(
							415,
							Math.min(466, Number(reference) || 440)
						))} /><span>Hz</span></label>
		</div>
	</ViewerPanel>
{/if}

<style>
	button,
	input,
	select {
		font: inherit;
	}
	button {
		cursor: pointer;
		color: var(--sonora-text);
		border: 0;
		background: transparent;
		display: grid;
		place-items: center;
		padding: 0;
	}
	button:focus-visible,
	input:focus-visible,
	select:focus-visible {
		outline: 2px solid var(--sonora-accent);
		outline-offset: 4px;
	}
	button:hover {
		filter: brightness(1.12);
	}
	input[type='number'] {
		appearance: textfield;
		-moz-appearance: textfield;
	}
	input::-webkit-inner-spin-button,
	input::-webkit-outer-spin-button {
		appearance: none;
		margin: 0;
	}
	input[type='range'] {
		accent-color: var(--sonora-accent);
		cursor: pointer;
		height: 3px;
		min-width: 0;
	}
	p {
		margin: 0;
		font-size: 11px;
		line-height: 1.6;
		color: var(--sonora-text-muted);
	}
	.metronome-app {
		padding: 26px 24px 24px;
	}
	.tempo-orbit {
		position: relative;
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		height: 210px;
		width: 210px;
		margin: 0 auto 24px;
		isolation: isolate;
	}
	.orbit-ring {
		position: absolute;
		inset: 0;
		border-radius: 50%;
		border: 1px solid var(--sonora-border-strong);
		box-shadow: inset 0 0 0 8px var(--sonora-bg-hover);
	}
	.playing .orbit-ring {
		border-color: var(--sonora-accent);
		box-shadow:
			inset 0 0 0 8px var(--sonora-accent-soft),
			0 0 36px var(--sonora-accent-soft);
	}
	.tempo-word {
		text-transform: uppercase;
		letter-spacing: 0.17em;
		font-size: 10px;
		color: var(--sonora-accent);
		margin-top: 5px;
	}
	.tempo-number {
		display: flex;
		flex-direction: column;
		align-items: center;
		margin: 10px 0 17px;
		gap: 3px;
	}
	.tempo-number input {
		width: 150px;
		border: 0;
		background: transparent;
		text-align: center;
		color: var(--sonora-text);
		font-size: 64px;
		font-weight: 300;
		line-height: 1;
		letter-spacing: -0.07em;
		padding: 0;
	}
	.tempo-number > span {
		font-size: 9px;
		letter-spacing: 0.15em;
		color: var(--sonora-text-muted);
	}
	.beat-dots {
		display: flex;
		gap: 9px;
		height: 10px;
		align-items: center;
	}
	.beat-dots i {
		display: block;
		width: 6px;
		height: 6px;
		border-radius: 50%;
		background: var(--sonora-border-strong);
		transition:
			background 60ms,
			transform 60ms;
	}
	.beat-dots i.downbeat {
		width: 8px;
		height: 8px;
	}
	.beat-dots i.lit {
		background: var(--sonora-accent);
		transform: scale(1.3);
		box-shadow: 0 0 10px var(--sonora-accent-soft);
	}
	.tempo-adjust {
		display: flex;
		align-items: center;
		gap: 16px;
	}
	.tempo-slider {
		flex: 1;
		width: 100%;
	}
	.small-icon {
		width: 28px;
		height: 28px;
		border-radius: 50%;
		background: var(--sonora-bg-hover);
		color: var(--sonora-text-secondary);
	}
	.meter-row {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
		margin: 24px 0;
		color: var(--sonora-text-muted);
		font-size: 10px;
	}
	.beat-options {
		display: flex;
		gap: 2px;
		padding: 3px;
		border-radius: 9px;
		background: var(--sonora-bg-deep);
	}
	.beat-options button,
	.beat-options select {
		width: 25px;
		height: 27px;
		font-size: 11px;
		border-radius: 6px;
	}
	.beat-options button {
		color: var(--sonora-text-muted);
	}
	.beat-options button.chosen {
		color: var(--sonora-text);
		background: var(--sonora-bg-active);
		box-shadow: 0 1px 3px #0002;
	}
	.beat-options select {
		border: 0;
		color: var(--sonora-text-muted);
		background: transparent;
		text-align: center;
		appearance: none;
		cursor: pointer;
	}
	.beat-options option {
		background: var(--sonora-bg-panel-solid);
	}
	.transport {
		display: grid;
		grid-template-columns: 1fr 70px 1fr;
		align-items: center;
		gap: 18px;
		margin-top: 28px;
	}
	.play-control,
	.mic-control {
		height: 64px;
		width: 64px;
		border-radius: 50%;
		color: var(--sonora-accent-contrast);
		background: var(--sonora-accent);
		box-shadow: 0 4px 18px var(--sonora-accent-soft);
		justify-self: center;
	}
	.play-control:active,
	.mic-control:active {
		transform: scale(0.97);
	}
	.play-control:not(.playing) {
		padding-left: 3px;
	}
	.tap-control {
		gap: 6px;
		font-size: 9px;
		color: var(--sonora-text-muted);
	}
	.volume-control {
		display: grid;
		justify-items: center;
		gap: 10px;
	}
	.volume-control button {
		color: var(--sonora-text-muted);
	}
	.volume-control input {
		width: 49px;
	}
	.app-footer {
		padding: 15px 22px;
		border-top: 1px solid var(--sonora-border);
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 10px;
		color: var(--sonora-text-muted);
	}
	.status-dot {
		width: 5px;
		height: 5px;
		border-radius: 50%;
		background: var(--sonora-text-faint);
	}
	.status-dot.live {
		background: var(--sonora-accent);
	}
	.footer-end {
		margin-left: auto;
		font-variant-numeric: tabular-nums;
		letter-spacing: 0.08em;
	}
	.tuner-app {
		padding: 31px 24px 25px;
		text-align: center;
	}
	.tuning-status {
		font-size: 9px;
		letter-spacing: 0.17em;
		color: var(--sonora-text-muted);
		height: 14px;
	}
	.note-display {
		font-size: 85px;
		letter-spacing: -0.07em;
		font-weight: 300;
		line-height: 1.2;
		margin-top: 10px;
		height: 106px;
	}
	.note-display > span {
		font-size: 26px;
		vertical-align: baseline;
		margin-left: 6px;
		color: var(--sonora-text-muted);
	}
	.cents-label {
		font-size: 11px;
		color: var(--sonora-text-muted);
		height: 18px;
		font-variant-numeric: tabular-nums;
	}
	.pitch-gauge {
		position: relative;
		height: 55px;
		margin-top: 23px;
		display: flex;
		align-items: center;
	}
	.gauge-ticks {
		width: 100%;
		display: flex;
		align-items: center;
		justify-content: space-between;
	}
	.gauge-ticks i {
		width: 1px;
		height: 13px;
		background: var(--sonora-border-strong);
	}
	.gauge-ticks i.major {
		height: 22px;
	}
	.gauge-ticks i.center {
		height: 34px;
		background: var(--sonora-accent);
	}
	.target-zone {
		position: absolute;
		left: 45%;
		width: 10%;
		top: 8px;
		bottom: 8px;
		background: var(--sonora-accent-soft);
		border-radius: 5px;
	}
	.needle {
		position: absolute;
		left: var(--needle);
		top: 4px;
		width: 2px;
		bottom: 4px;
		background: var(--sonora-accent);
		transform: translateX(-50%);
		transition: left 100ms ease;
		border-radius: 2px;
		box-shadow: 0 0 9px var(--sonora-accent-soft);
	}
	.needle:before {
		content: '';
		position: absolute;
		top: -4px;
		left: -3px;
		width: 8px;
		height: 8px;
		background: var(--sonora-accent);
		border-radius: 50%;
	}
	.needle.idle {
		opacity: 0.25;
	}
	.gauge-labels {
		display: flex;
		justify-content: space-between;
		color: var(--sonora-text-muted);
		font-size: 13px;
		align-items: center;
	}
	.gauge-labels span:nth-child(2) {
		font-size: 9px;
	}
	.tuner-guidance {
		margin: 20px auto 22px;
		min-height: 35px;
		max-width: 220px;
		font-size: 11px;
	}
	.mic-control {
		margin: 0 auto;
	}
	.mic-control.listening {
		background: var(--sonora-accent-soft);
		box-shadow: inset 0 0 0 1px var(--sonora-border-focus);
		color: var(--sonora-accent);
	}
	.mic-label {
		display: block;
		margin-top: 10px;
		font-size: 10px;
		color: var(--sonora-text-muted);
	}
	.in-tune .note-display,
	.in-tune .tuning-status {
		color: var(--sonora-success);
	}
	.calibration {
		border-top: 1px solid var(--sonora-border);
		padding: 17px 22px;
		display: flex;
		align-items: center;
		justify-content: space-between;
		font-size: 10px;
		color: var(--sonora-text-muted);
	}
	.calibration label {
		display: flex;
		align-items: center;
		gap: 6px;
	}
	.calibration input {
		width: 40px;
		background: var(--sonora-bg-hover);
		border: 1px solid var(--sonora-border);
		border-radius: 5px;
		padding: 5px 2px;
		text-align: center;
		color: var(--sonora-text);
		font-size: 11px;
	}
	.calibration label > span {
		font-size: 9px;
	}
</style>
