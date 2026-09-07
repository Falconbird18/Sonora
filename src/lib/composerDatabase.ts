import database from '../data/composers.json';

export interface ComposerRecord {
	id: string;
	name: string;
	aliases: string[];
	period: string;
	birthYear: number;
	deathYear: number | null;
	birthPlace: string;
	country: string;
	portraitFiles: string[];
	portraitQuery?: string;
	portraitUrl?: string;
}

const DATABASE_COMPOSERS = database as ComposerRecord[];

// Additional pedagogical and repertoire composers. These are kept here so the
// JSON database can remain stable while their Commons portraits are referenced
// by a known, deterministic URL.
const ADDITIONAL_COMPOSERS: ComposerRecord[] = [
	{
		id: 'hanon', name: 'Charles-Louis Hanon',
		aliases: ['Hanon', 'Charles-Louis Hanon', 'Charles Louis Hanon'],
		period: 'Romantic', birthYear: 1819, deathYear: 1900,
		birthPlace: 'Renescure, France', country: 'France', portraitFiles: ['Charles-Louis Hanon.jpg'],
		portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Charles-Louis_Hanon.jpg?width=256'
	},
	{
		id: 'burgmuller', name: 'Friedrich Burgmüller',
		aliases: ['Burgmuller', 'Burgmüller', 'Friedrich Burgmuller', 'Friedrich Burgmüller'],
		period: 'Romantic', birthYear: 1806, deathYear: 1874,
		birthPlace: 'Regensburg, Kingdom of Bavaria', country: 'Germany / France', portraitFiles: ['Friedrich Burgmüller.jpg'],
		portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Friedrich_Burgm%C3%BCller.jpg?width=256'
	},
	{
		id: 'heller', name: 'Stephen Heller',
		aliases: ['Heller', 'Stephen Heller'], period: 'Romantic', birthYear: 1813, deathYear: 1888,
		birthPlace: 'Budapest, Kingdom of Hungary', country: 'Hungary / France', portraitFiles: ['Stephen Heller.jpg'],
		portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Stephen_Heller.jpg?width=256'
	},
	{
		id: 'moszkowski', name: 'Moritz Moszkowski',
		aliases: ['Moszkowski', 'Moritz Moszkowski'], period: 'Romantic', birthYear: 1854, deathYear: 1925,
		birthPlace: 'Breslau, Kingdom of Prussia', country: 'Germany', portraitFiles: ['Moritz Moszkowski.jpg'],
		portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Moritz_Moszkowski.jpg?width=256'
	},
	{
		id: 'duvernoy', name: 'Jean-Baptiste Duvernoy',
		aliases: ['Duvernoy', 'Jean-Baptiste Duvernoy'], period: 'Romantic', birthYear: 1802, deathYear: 1880,
		birthPlace: 'France', country: 'France', portraitFiles: ['Jean-Baptiste Duvernoy.jpg'],
		portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Jean-Baptiste_Duvernoy.jpg?width=256'
	},
	{
		id: 'joplin', name: 'Scott Joplin', aliases: ['Joplin', 'Scott Joplin'], period: 'Modern / Ragtime',
		birthYear: 1868, deathYear: 1917, birthPlace: 'Texarkana, United States', country: 'United States',
		portraitFiles: ['Scott Joplin portrait photo highres.jpg'],
		portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Scott_Joplin_portrait_photo_highres.jpg?width=256'
	},
	{
		id: 'kuhlau', name: 'Friedrich Kuhlau', aliases: ['Kuhlau', 'Friedrich Kuhlau'], period: 'Classical / Romantic',
		birthYear: 1786, deathYear: 1832, birthPlace: 'Uelzen, Electorate of Hanover', country: 'Denmark / Germany',
		portraitFiles: ['PPN663956137 Friedrich Kuhlau.jpg'],
		portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/PPN663956137_Friedrich_Kuhlau.jpg?width=256'
	}
];

// John Williams had an unreliable search-based portrait. Pin the portrait to
// the documented 2006 Boston Symphony Hall photograph on Wikimedia Commons.
const FIXED_PORTRAITS: Record<string, string> = {
	williams: 'https://commons.wikimedia.org/wiki/Special:FilePath/John_Williams_2006._%282%29.jpg?width=256'
};

export const COMPOSERS = [...DATABASE_COMPOSERS, ...ADDITIONAL_COMPOSERS].map((composer) => ({
	...composer,
	portraitUrl: FIXED_PORTRAITS[composer.id] ?? composer.portraitUrl
})) as ComposerRecord[];

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
	return normalizedRecords.find(({ composer, terms }) => composer.id === normalized || terms.includes(normalized))?.composer ?? null;
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
	return composer.portraitUrl ?? `/composers/${composer.id}.jpg`;
}
