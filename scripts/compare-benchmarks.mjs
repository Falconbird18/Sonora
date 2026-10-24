import { readFileSync } from 'node:fs';
const [
	beforePath = 'benchmarks/baseline.json',
	afterPath = 'benchmarks/optimized.json'
] = process.argv.slice(2);
const before = JSON.parse(readFileSync(beforePath, 'utf8'));
const after = JSON.parse(readFileSync(afterPath, 'utf8'));
console.table(
	before.rows.flatMap((row) => {
		const next = after.rows.find(
			(candidate) => candidate.name === row.name && candidate.size === row.size
		);
		return next
			? [
					{
						workload: row.name,
						size: row.size,
						beforeMs: row.medianMs,
						afterMs: next.medianMs,
						speedup: `${(row.medianMs / next.medianMs).toFixed(1)}x`
					}
				]
			: [];
	})
);
