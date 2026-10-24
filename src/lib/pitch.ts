/** Monophonic autocorrelation with sub-sample interpolation, for sustained instrumental notes. */
export function detectFrequency(
	samples: Float32Array,
	sampleRate: number
): number | null {
	let energy = 0,
		mean = 0;
	for (const sample of samples) mean += sample;
	mean /= samples.length;
	for (const sample of samples) energy += (sample - mean) ** 2;
	if (Math.sqrt(energy / samples.length) < 0.008) return null;
	const min = Math.max(2, Math.floor(sampleRate / 1400)),
		max = Math.min(
			Math.floor(samples.length / 2) - 2,
			Math.ceil(sampleRate / 55)
		);
	const count = samples.length - max - 1,
		correlations = new Float32Array(max + 2);
	for (let lag = min - 1; lag <= max + 1; lag++) {
		let sum = 0,
			a = 0,
			b = 0;
		for (let i = 0; i < count; i++) {
			const x = samples[i] - mean,
				y = samples[i + lag] - mean;
			sum += x * y;
			a += x * x;
			b += y * y;
		}
		correlations[lag] = sum / Math.sqrt(a * b || 1);
		if (lag > min + 1) {
			const peak = lag - 1;
			if (
				correlations[peak] > 0.94 &&
				correlations[peak] >= correlations[peak - 1] &&
				correlations[peak] > correlations[lag]
			) {
				const left = correlations[peak - 1],
					center = correlations[peak],
					right = correlations[lag],
					denominator = left - 2 * center + right;
				const offset =
					denominator === 0 ? 0 : (0.5 * (left - right)) / denominator;
				return sampleRate / (peak + offset);
			}
		}
	}
	return null;
}
export function describePitch(frequency: number, reference = 440) {
	const midi = 69 + 12 * Math.log2(frequency / reference),
		rounded = Math.round(midi);
	const names = [
		'C',
		'C♯',
		'D',
		'E♭',
		'E',
		'F',
		'F♯',
		'G',
		'A♭',
		'A',
		'B♭',
		'B'
	];
	return {
		note: names[((rounded % 12) + 12) % 12] + (Math.floor(rounded / 12) - 1),
		cents: Math.round((midi - rounded) * 100)
	};
}
