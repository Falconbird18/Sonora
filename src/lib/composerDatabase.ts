import database from '../data/composers.json';

export interface ComposerRecord {
	id: string;
	name: string;
	aliases: string[];
	period: string;
	birthYear: number;
	deathYear: number;
	birthPlace: string;
	country: string;
	portraitFiles: string[];
	portraitQuery?: string;
}

export const COMPOSERS = database as ComposerRecord[];

function normalize(value: string): string {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');
}

const normalizedRecords = COMPOSERS.map((composer) => ({
	composer,
	terms: [composer.name, ...composer.aliases].map(normalize)
}));

export function getComposer(id: string): ComposerRecord | null {
	return COMPOSERS.find((composer) => composer.id === id) ?? null;
}

export function findComposer(value: string): ComposerRecord | null {
	const normalized = normalize(value);
	if (!normalized) return null;
	return (
		normalizedRecords.find(({ composer, terms }) => composer.id === normalized || terms.includes(normalized))
			?.composer ?? null
	);
}

export function searchComposers(query: string, limit = 8): ComposerRecord[] {
	const normalized = normalize(query);
	if (!normalized) return COMPOSERS.slice(0, limit);

	return normalizedRecords
		.map(({ composer, terms }) => {
			const exact = terms.some((term) => term === normalized);
			const starts = terms.some((term) => term.startsWith(normalized));
			const contains = terms.some((term) => term.includes(normalized));
			const name = normalize(composer.name);
			const score = exact ? 0 : starts ? 1 : name.startsWith(normalized) ? 2 : contains ? 3 : 99;
			return { composer, score };
		})
		.filter(({ score }) => score < 99)
		.sort((a, b) => a.score - b.score || a.composer.name.localeCompare(b.composer.name))
		.slice(0, limit)
		.map(({ composer }) => composer);
}

export function getComposerPortraitPath(composer: ComposerRecord): string {
	return `/composers/${composer.id}.jpg`;
}
