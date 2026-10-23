import { findComposer } from './composerDatabase';
import { parseWorkTitle } from './imslp';
import type { ScoreItem } from './types';

export type LibraryWork = {
	id: string;
	title: string;
	composer: string;
	scores: ScoreItem[];
};
export function groupWorks(scores: ScoreItem[]): LibraryWork[] {
	const groups = new Map<string, LibraryWork>();
	for (const score of scores) {
		const title = score.workTitle || score.title;
		const id = `${score.composer.toLocaleLowerCase()}::${title.toLocaleLowerCase()}`;
		let work = groups.get(id);
		if (!work) {
			work = { id, title, composer: score.composer, scores: [] };
			groups.set(id, work);
		}
		work.scores.push(score);
	}
	return [...groups.values()];
}

export function createRepairContext(scores: ScoreItem[]) {
	const titles = new Map<string, Set<string>>();
	for (const score of scores) {
		let composerTitles = titles.get(score.composer);
		if (!composerTitles)
			titles.set(score.composer, (composerTitles = new Set()));
		composerTitles.add(score.title);
	}
	return titles;
}

/** Only repair information supported by a known composer or a complete IMSLP-style title. */
export function repairMetadata(
	score: ScoreItem,
	all: ScoreItem[],
	context?: ReturnType<typeof createRepairContext>
): Partial<ScoreItem> {
	if (score.metadataEdited) return {};
	const patch: Partial<ScoreItem> = {};
	const record = findComposer(score.composer);
	if (record && record.name !== score.composer) {
		patch.composer = record.name;
		patch.composerId = record.id;
	}
	if (!score.workTitle && /\([^()]+, [^()]+\)$/.test(score.title)) {
		const parsed = parseWorkTitle(score.title);
		if (findComposer(parsed.composer)) {
			patch.title = parsed.title;
			patch.workTitle = parsed.title;
			patch.composer = parsed.composer;
		}
	}
	// Legacy downloads used numbered copies of the same work title.
	const base = score.title.replace(/ \(\d+\)$/, '');
	if (
		!score.workTitle &&
		base !== score.title &&
		(context
			? context.get(score.composer)?.has(base)
			: all.some(
					(other) => other.title === base && other.composer === score.composer
				))
	)
		patch.workTitle = base;
	return patch;
}
