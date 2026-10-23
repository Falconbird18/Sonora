import type { ScoreItem } from './types';
export type LibraryQuery = {
	search: string;
	composer: string | null;
	filter: string;
	sort: string;
};

/** Reuse normalized fields and sort order across keystrokes; rebuild when scores change. */
export function createLibraryQuery(scores: ScoreItem[]) {
	const fields = new Map<ScoreItem, string[]>();
	const orders = new Map<string, ScoreItem[]>();
	return ({ search, composer, filter, sort }: LibraryQuery): ScoreItem[] => {
		let ordered = orders.get(sort);
		if (!ordered) {
			ordered = [...scores].sort((a, b) =>
				sort === 'title'
					? a.title.localeCompare(b.title)
					: sort === 'composer'
						? a.composer.localeCompare(b.composer) ||
							a.title.localeCompare(b.title)
						: (b.lastOpenedAt || b.addedAt) - (a.lastOpenedAt || a.addedAt)
			);
			orders.set(sort, ordered);
		}
		const query = search.trim().toLowerCase();
		return ordered.filter((score) => {
			if (composer && score.composer !== composer) return false;
			if (
				filter !== 'all' &&
				!(filter === 'favorites' ? score.favorite : score.lastOpenedAt)
			)
				return false;
			if (!query) return true;
			let terms = fields.get(score);
			if (!terms) {
				terms = [
					score.title,
					score.composer,
					score.workTitle,
					score.edition,
					score.catalogue,
					score.key,
					score.instruments,
					score.publisher,
					score.editor,
					...(score.tags ?? [])
				]
					.filter((value): value is string => typeof value === 'string')
					.map((value) => value.toLowerCase());
				fields.set(score, terms);
			}
			return terms.some((term) => term.includes(query));
		});
	};
}
