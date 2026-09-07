import database from '../data/composers.json';

export interface ComposerRecord {
	id: string; name: string; aliases: string[]; period: string; birthYear: number; deathYear: number | null;
	birthPlace: string; country: string; portraitFiles: string[]; portraitQuery?: string; portraitUrl?: string;
}

const DATABASE_COMPOSERS = database as ComposerRecord[];

// Extra repertoire composers kept outside the base JSON so their portraits can
// use deterministic Wikimedia Commons FilePath URLs.
const ADDITIONAL_COMPOSERS: ComposerRecord[] = [
	{
		id: 'hanon', name: 'Charles-Louis Hanon', aliases: ['Hanon', 'Charles-Louis Hanon', 'Charles Louis Hanon'], period: 'Romantic', birthYear: 1819, deathYear: 1900,
		birthPlace: 'Renescure, France', country: 'France', portraitFiles: ['Charles-Louis Hanon.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Charles-Louis_Hanon.jpg?width=256'
	},
	{
		id: 'burgmuller', name: 'Friedrich Burgmüller', aliases: ['Burgmuller', 'Burgmüller', 'Friedrich Burgmuller', 'Friedrich Burgmüller'], period: 'Romantic', birthYear: 1806, deathYear: 1874,
		birthPlace: 'Regensburg, Kingdom of Bavaria', country: 'Germany / France', portraitFiles: ['Friedrich Burgmüller.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Friedrich_Burgm%C3%BCller.jpg?width=256'
	},
	{
		id: 'heller', name: 'Stephen Heller', aliases: ['Heller', 'Stephen Heller'], period: 'Romantic', birthYear: 1813, deathYear: 1888,
		birthPlace: 'Budapest, Kingdom of Hungary', country: 'Hungary / France', portraitFiles: ['Stephen Heller.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Stephen_Heller.jpg?width=256'
	},
	{
		id: 'moszkowski', name: 'Moritz Moszkowski', aliases: ['Moszkowski', 'Moritz Moszkowski'], period: 'Romantic', birthYear: 1854, deathYear: 1925,
		birthPlace: 'Breslau, Kingdom of Prussia', country: 'Germany', portraitFiles: ['Moritz Moszkowski.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Moritz_Moszkowski.jpg?width=256'
	},
	{
		id: 'duvernoy', name: 'Jean-Baptiste Duvernoy', aliases: ['Duvernoy', 'Jean-Baptiste Duvernoy'], period: 'Romantic', birthYear: 1802, deathYear: 1880,
		birthPlace: 'France', country: 'France', portraitFiles: ['Jean-Baptiste Duvernoy.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Jean-Baptiste_Duvernoy.jpg?width=256'
	},
	{
		id: 'joplin', name: 'Scott Joplin', aliases: ['Joplin', 'Scott Joplin'], period: 'Modern / Ragtime', birthYear: 1868, deathYear: 1917,
		birthPlace: 'Texarkana, United States', country: 'United States', portraitFiles: ['Scott Joplin portrait photo highres.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Scott_Joplin_portrait_photo_highres.jpg?width=256'
	},
	{
		id: 'kuhlau', name: 'Friedrich Kuhlau', aliases: ['Kuhlau', 'Friedrich Kuhlau'], period: 'Classical / Romantic', birthYear: 1786, deathYear: 1832,
		birthPlace: 'Uelzen, Electorate of Hanover', country: 'Denmark / Germany', portraitFiles: ['PPN663956137 Friedrich Kuhlau.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/PPN663956137_Friedrich_Kuhlau.jpg?width=256'
	},
	{
		id: 'cpe-bach', name: 'Carl Philipp Emanuel Bach', aliases: ['C.P.E. Bach', 'CPE Bach', 'Carl Philipp Emanuel Bach'], period: 'Baroque / Classical', birthYear: 1714, deathYear: 1788,
		birthPlace: 'Weimar, Duchy of Saxe-Weimar', country: 'Germany', portraitFiles: ['Carl Philipp Emanuel Bach.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Carl_Philipp_Emanuel_Bach.jpg?width=256'
	},
	{
		id: 'boccherini', name: 'Luigi Boccherini', aliases: ['Boccherini', 'Luigi Boccherini'], period: 'Classical', birthYear: 1743, deathYear: 1805,
		birthPlace: 'Lucca, Republic of Lucca', country: 'Italy / Spain', portraitFiles: ['Luigi Boccherini.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Luigi_Boccherini.jpg?width=256'
	},
	{
		id: 'hummel', name: 'Johann Nepomuk Hummel', aliases: ['Hummel', 'Johann Hummel', 'Johann Nepomuk Hummel'], period: 'Classical / Romantic', birthYear: 1778, deathYear: 1837,
		birthPlace: 'Pressburg, Kingdom of Hungary', country: 'Austria', portraitFiles: ['Johann Nepomuk Hummel.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Johann_Nepomuk_Hummel.jpg?width=256'
	},
	{
		id: 'dussek', name: 'Jan Ladislav Dussek', aliases: ['Dussek', 'Jan Ladislav Dussek', 'Johann Ladislaus Dussek'], period: 'Classical / Romantic', birthYear: 1760, deathYear: 1812,
		birthPlace: 'Čáslav, Kingdom of Bohemia', country: 'Bohemia', portraitFiles: ['Jan Ladislav Dussek.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Jan_Ladislav_Dussek.jpg?width=256'
	},
	{
		id: 'field', name: 'John Field', aliases: ['Field', 'John Field'], period: 'Classical / Romantic', birthYear: 1782, deathYear: 1837,
		birthPlace: 'Dublin, Kingdom of Ireland', country: 'Ireland / Russia', portraitFiles: ['John Field composer.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/John_Field_composer.jpg?width=256'
	},
	{
		id: 'weber', name: 'Carl Maria von Weber', aliases: ['Weber', 'Carl Maria von Weber'], period: 'Romantic', birthYear: 1786, deathYear: 1826,
		birthPlace: 'Eutin, Holy Roman Empire', country: 'Germany', portraitFiles: ['Carl Maria von Weber.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Carl_Maria_von_Weber.jpg?width=256'
	},
	{
		id: 'faure', name: 'Gabriel Fauré', aliases: ['Faure', 'Fauré', 'Gabriel Fauré'], period: 'Romantic / Modern', birthYear: 1845, deathYear: 1924,
		birthPlace: 'Pamiers, France', country: 'France', portraitFiles: ['Gabriel Fauré.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Gabriel_Faur%C3%A9.jpg?width=256'
	},
	{
		id: 'franck', name: 'César Franck', aliases: ['Franck', 'Cesar Franck', 'César Franck'], period: 'Romantic', birthYear: 1822, deathYear: 1890,
		birthPlace: 'Liège, United Kingdom of the Netherlands', country: 'Belgium / France', portraitFiles: ['Cesar Franck.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Cesar_Franck.jpg?width=256'
	},
	{
		id: 'alkan', name: 'Charles-Valentin Alkan', aliases: ['Alkan', 'Charles-Valentin Alkan'], period: 'Romantic', birthYear: 1813, deathYear: 1888,
		birthPlace: 'Paris, France', country: 'France', portraitFiles: ['Charles-Valentin Alkan.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Charles-Valentin_Alkan.jpg?width=256'
	},
	{
		id: 'chabrier', name: 'Emmanuel Chabrier', aliases: ['Chabrier', 'Emmanuel Chabrier'], period: 'Romantic', birthYear: 1841, deathYear: 1894,
		birthPlace: 'Ambert, France', country: 'France', portraitFiles: ['Emmanuel Chabrier.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Emmanuel_Chabrier.jpg?width=256'
	},
	{
		id: 'delius', name: 'Frederick Delius', aliases: ['Delius', 'Frederick Delius'], period: 'Late Romantic', birthYear: 1862, deathYear: 1934,
		birthPlace: 'Bradford, England', country: 'United Kingdom', portraitFiles: ['Frederick Delius.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Frederick_Delius.jpg?width=256'
	},
	{
		id: 'lalo', name: 'Édouard Lalo', aliases: ['Lalo', 'Edouard Lalo', 'Édouard Lalo'], period: 'Romantic', birthYear: 1823, deathYear: 1892,
		birthPlace: 'Lille, France', country: 'France', portraitFiles: ['Edouard Lalo.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Edouard_Lalo.jpg?width=256'
	},
	{
		id: 'smetana', name: 'Bedřich Smetana', aliases: ['Smetana', 'Bedrich Smetana', 'Bedřich Smetana'], period: 'Romantic', birthYear: 1824, deathYear: 1884,
		birthPlace: 'Litomyšl, Austrian Empire', country: 'Czech Republic', portraitFiles: ['Bedrich Smetana.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Bedrich_Smetana.jpg?width=256'
	},
	{
		id: 'nielsen', name: 'Carl Nielsen', aliases: ['Nielsen', 'Carl Nielsen'], period: 'Late Romantic / Modern', birthYear: 1865, deathYear: 1931,
		birthPlace: 'Nørre Lyndelse, Denmark', country: 'Denmark', portraitFiles: ['Carl Nielsen.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Carl_Nielsen.jpg?width=256'
	},
	{
		id: 'janacek', name: 'Leoš Janáček', aliases: ['Janacek', 'Janáček', 'Leos Janacek', 'Leoš Janáček'], period: 'Modern', birthYear: 1854, deathYear: 1928,
		birthPlace: 'Hukvaldy, Austrian Empire', country: 'Czech Republic', portraitFiles: ['Leos Janacek.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Leos_Janacek.jpg?width=256'
	},
	{
		id: 'honegger', name: 'Arthur Honegger', aliases: ['Honegger', 'Arthur Honegger'], period: 'Modern', birthYear: 1892, deathYear: 1955,
		birthPlace: 'Le Havre, France', country: 'Switzerland / France', portraitFiles: ['Arthur Honegger.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Arthur_Honegger.jpg?width=256'
	},
	{
		id: 'messiaen', name: 'Olivier Messiaen', aliases: ['Messiaen', 'Olivier Messiaen'], period: 'Modern', birthYear: 1908, deathYear: 1992,
		birthPlace: 'Avignon, France', country: 'France', portraitFiles: ['Olivier Messiaen.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Olivier_Messiaen.jpg?width=256'
	},
	{
		id: 'scriabin', name: 'Alexander Scriabin', aliases: ['Scriabin', 'Alexander Scriabin', 'Aleksandr Scriabin'], period: 'Late Romantic / Modern', birthYear: 1872, deathYear: 1915,
		birthPlace: 'Moscow, Russian Empire', country: 'Russia', portraitFiles: ['Alexander Scriabin.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Alexander_Scriabin.jpg?width=256'
	},
	{
		id: 'medtner', name: 'Nikolai Medtner', aliases: ['Medtner', 'Nikolai Medtner'], period: 'Late Romantic', birthYear: 1880, deathYear: 1951,
		birthPlace: 'Moscow, Russian Empire', country: 'Russia', portraitFiles: ['Nikolai Medtner.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Nikolai_Medtner.jpg?width=256'
	},
	{
		id: 'chaminade', name: 'Cécile Chaminade', aliases: ['Chaminade', 'Cecile Chaminade', 'Cécile Chaminade'], period: 'Romantic', birthYear: 1857, deathYear: 1944,
		birthPlace: 'Paris, France', country: 'France', portraitFiles: ['Cécile Chaminade.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/C%C3%A9cile_Chaminade.jpg?width=256'
	},
	{
		id: 'amy-beach', name: 'Amy Beach', aliases: ['Beach', 'Amy Beach', 'Amy Marcy Beach'], period: 'Romantic / Modern', birthYear: 1867, deathYear: 1944,
		birthPlace: 'Henniker, New Hampshire, United States', country: 'United States', portraitFiles: ['Amy Beach.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Amy_Beach.jpg?width=256'
	},
	{
		id: 'clara-schumann', name: 'Clara Schumann', aliases: ['Clara Schumann', 'Clara Wieck'], period: 'Romantic', birthYear: 1819, deathYear: 1896,
		birthPlace: 'Leipzig, Kingdom of Saxony', country: 'Germany', portraitFiles: ['Clara Schumann.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Clara_Schumann.jpg?width=256'
	},
	{
		id: 'fanny-mendelssohn', name: 'Fanny Mendelssohn', aliases: ['Fanny Mendelssohn', 'Fanny Hensel'], period: 'Romantic', birthYear: 1805, deathYear: 1847,
		birthPlace: 'Hamburg, First French Empire', country: 'Germany', portraitFiles: ['Fanny Mendelssohn Hensel.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Fanny_Mendelssohn_Hensel.jpg?width=256'
	},
	{
		id: 'farrenc', name: 'Louise Farrenc', aliases: ['Farrenc', 'Louise Farrenc'], period: 'Romantic', birthYear: 1804, deathYear: 1875,
		birthPlace: 'Paris, France', country: 'France', portraitFiles: ['Louise Farrenc.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Louise_Farrenc.jpg?width=256'
	},
	{
		id: 'raff', name: 'Joachim Raff', aliases: ['Raff', 'Joachim Raff'], period: 'Romantic', birthYear: 1822, deathYear: 1882,
		birthPlace: 'Lachen, Switzerland', country: 'Switzerland / Germany', portraitFiles: ['Joachim Raff.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Joachim_Raff.jpg?width=256'
	},
	{
		id: 'rubinstein', name: 'Anton Rubinstein', aliases: ['Rubinstein', 'Anton Rubinstein'], period: 'Romantic', birthYear: 1829, deathYear: 1894,
		birthPlace: 'Vikhvatinets, Russian Empire', country: 'Russia', portraitFiles: ['Anton Rubinstein.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Anton_Rubinstein.jpg?width=256'
	},
	{
		id: 'massenet', name: 'Jules Massenet', aliases: ['Massenet', 'Jules Massenet'], period: 'Romantic', birthYear: 1842, deathYear: 1912,
		birthPlace: 'Montaud, France', country: 'France', portraitFiles: ['Jules Massenet.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Jules_Massenet.jpg?width=256'
	},
	{
		id: 'delibes', name: 'Léo Delibes', aliases: ['Delibes', 'Leo Delibes', 'Léo Delibes'], period: 'Romantic', birthYear: 1836, deathYear: 1891,
		birthPlace: 'Saint-Germain-du-Val, France', country: 'France', portraitFiles: ['Léo Delibes.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/L%C3%A9o_Delibes.jpg?width=256'
	},
	{
		id: 'buxtehude', name: 'Dieterich Buxtehude', aliases: ['Buxtehude', 'Dieterich Buxtehude'], period: 'Baroque', birthYear: 1637, deathYear: 1707,
		birthPlace: 'Helsingborg, Denmark-Norway', country: 'Denmark / Germany', portraitFiles: ['Dieterich Buxtehude.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Dieterich_Buxtehude.jpg?width=256'
	},
	{
		id: 'sor', name: 'Fernando Sor', aliases: ['Sor', 'Fernando Sor'], period: 'Classical / Romantic', birthYear: 1778, deathYear: 1839,
		birthPlace: 'Barcelona, Spain', country: 'Spain', portraitFiles: ['Fernando Sor.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Fernando_Sor.jpg?width=256'
	},
	{
		id: 'tarrega', name: 'Francisco Tárrega', aliases: ['Tarrega', 'Tárrega', 'Francisco Tárrega'], period: 'Romantic', birthYear: 1852, deathYear: 1909,
		birthPlace: 'Villarreal, Spain', country: 'Spain', portraitFiles: ['Francisco Tárrega.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Francisco_T%C3%A1rrega.jpg?width=256'
	},
	{
		id: 'granados', name: 'Enrique Granados', aliases: ['Granados', 'Enrique Granados'], period: 'Romantic / Modern', birthYear: 1867, deathYear: 1916,
		birthPlace: 'Lleida, Spain', country: 'Spain', portraitFiles: ['Enrique Granados.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Enrique_Granados.jpg?width=256'
	},
	{
		id: 'albeniz', name: 'Isaac Albéniz', aliases: ['Albeniz', 'Albéniz', 'Isaac Albéniz'], period: 'Romantic', birthYear: 1860, deathYear: 1909,
		birthPlace: 'Camprodon, Spain', country: 'Spain', portraitFiles: ['Isaac Albéniz.jpg'], portraitUrl: 'https://commons.wikimedia.org/wiki/Special:FilePath/Isaac_Alb%C3%A9niz.jpg?width=256'
	}
];

const FIXED_PORTRAITS: Record<string, string> = {
	williams: 'https://commons.wikimedia.org/wiki/Special:FilePath/John_Williams_2006._%282%29.jpg?width=256'
};

export const COMPOSERS = [...DATABASE_COMPOSERS, ...ADDITIONAL_COMPOSERS].map((composer) => ({
	...composer, portraitUrl: FIXED_PORTRAITS[composer.id] ?? composer.portraitUrl
})) as ComposerRecord[];

function normalize(value: string): string {
	return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

const normalizedRecords = COMPOSERS.map((composer) => ({ composer, terms: [composer.name, ...composer.aliases].map(normalize) }));

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
	return normalizedRecords.map(({ composer, terms }) => {
		const exact = terms.some((term) => term === normalized);
		const starts = terms.some((term) => term.startsWith(normalized));
		const contains = terms.some((term) => term.includes(normalized));
		const name = normalize(composer.name);
		const score = exact ? 0 : starts ? 1 : name.startsWith(normalized) ? 2 : contains ? 3 : 99;
		return { composer, score };
	}).filter(({ score }) => score < 99).sort((a, b) => a.score - b.score || a.composer.name.localeCompare(b.composer.name)).slice(0, limit).map(({ composer }) => composer);
}

export function getComposerPortraitPath(composer: ComposerRecord): string {
	return composer.portraitUrl ?? `/composers/${composer.id}.jpg`;
}
