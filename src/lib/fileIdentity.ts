/** Consume rename candidates once, preserving scanner order for duplicate identities. */
export function createMoveMatcher<
	T extends { id: string; fileSize?: number; fileModifiedAt?: number }
>(removed: T[]) {
	const buckets = new Map<string, { rows: T[]; cursor: number }>();
	for (const row of removed) {
		const key = `${row.fileSize}:${row.fileModifiedAt}`;
		let bucket = buckets.get(key);
		if (!bucket) buckets.set(key, (bucket = { rows: [], cursor: 0 }));
		bucket.rows.push(row);
	}
	return (size: number, modified: number): T | undefined => {
		const bucket = buckets.get(`${size}:${modified}`);
		return bucket?.rows[bucket.cursor++];
	};
}
