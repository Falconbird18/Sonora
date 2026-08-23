export type SymbolCategory =
	| 'Common'
	| 'Dynamics'
	| 'Articulations'
	| 'Accidentals'
	| 'Repeats'
	| 'Bowings'
	| 'Fingering'
	| 'Holds & Pauses';
export interface MusicalSymbol {
	id: string;
	label: string;
	symbol: string;
	category: SymbolCategory;
	keywords: string[];
}
const smufl = (codePoint: number) => String.fromCodePoint(codePoint);
export const MUSICAL_SYMBOLS: MusicalSymbol[] = [
	{
		id: 'fermata',
		label: 'Fermata',
		symbol: smufl(0xe4c0),
		category: 'Common',
		keywords: ['pause', 'hold']
	},
	{
		id: 'accent',
		label: 'Accent',
		symbol: smufl(0xe4a0),
		category: 'Common',
		keywords: ['accent']
	},
	{
		id: 'staccato',
		label: 'Staccato',
		symbol: smufl(0xe4a2),
		category: 'Common',
		keywords: ['dot', 'staccato']
	},
	{
		id: 'sharp',
		label: 'Sharp',
		symbol: smufl(0xe262),
		category: 'Common',
		keywords: ['sharp', 'accidental']
	},
	{
		id: 'flat',
		label: 'Flat',
		symbol: smufl(0xe260),
		category: 'Common',
		keywords: ['flat', 'accidental']
	},
	{
		id: 'natural',
		label: 'Natural',
		symbol: smufl(0xe261),
		category: 'Common',
		keywords: ['natural', 'accidental']
	},
	{
		id: 'tenuto',
		label: 'Tenuto',
		symbol: smufl(0xe4a4),
		category: 'Articulations',
		keywords: ['tenuto', 'line']
	},
	{
		id: 'marcato',
		label: 'Marcato',
		symbol: smufl(0xe4ac),
		category: 'Articulations',
		keywords: ['marcato', 'accent']
	},
	{
		id: 'double-sharp',
		label: 'Double sharp',
		symbol: smufl(0xe263),
		category: 'Accidentals',
		keywords: ['double', 'sharp', 'accidental']
	},
	{
		id: 'double-flat',
		label: 'Double flat',
		symbol: smufl(0xe264),
		category: 'Accidentals',
		keywords: ['double', 'flat', 'accidental']
	},
	{
		id: 'fermata-below',
		label: 'Fermata below',
		symbol: smufl(0xe4c1),
		category: 'Holds & Pauses',
		keywords: ['fermata', 'below', 'pause']
	},
	{
		id: 'breath',
		label: 'Breath mark',
		symbol: smufl(0xe4ce),
		category: 'Holds & Pauses',
		keywords: ['breath', 'comma']
	},
	{
		id: 'caesura',
		label: 'Caesura',
		symbol: smufl(0xe4d1),
		category: 'Holds & Pauses',
		keywords: ['pause', 'break']
	},
	{
		id: 'segno',
		label: 'Segno',
		symbol: smufl(0xe047),
		category: 'Repeats',
		keywords: ['segno', 'repeat', 'ds']
	},
	{
		id: 'coda',
		label: 'Coda',
		symbol: smufl(0xe048),
		category: 'Repeats',
		keywords: ['coda', 'repeat']
	},
	{
		id: 'dal-segno',
		label: 'Dal segno',
		symbol: smufl(0xe045),
		category: 'Repeats',
		keywords: ['ds', 'segno', 'repeat']
	},
	{
		id: 'da-capo',
		label: 'Da capo',
		symbol: smufl(0xe046),
		category: 'Repeats',
		keywords: ['dc', 'repeat']
	},
	{
		id: 'forte',
		label: 'Forte',
		symbol: smufl(0xe522),
		category: 'Dynamics',
		keywords: ['f', 'loud', 'dynamic']
	},
	{
		id: 'piano',
		label: 'Piano',
		symbol: smufl(0xe520),
		category: 'Dynamics',
		keywords: ['p', 'soft', 'dynamic']
	},
	{
		id: 'mezzo-forte',
		label: 'Mezzo forte',
		symbol: smufl(0xe52d),
		category: 'Dynamics',
		keywords: ['mf', 'dynamic']
	},
	{
		id: 'mezzo-piano',
		label: 'Mezzo piano',
		symbol: smufl(0xe52c),
		category: 'Dynamics',
		keywords: ['mp', 'dynamic']
	},
	{
		id: 'fortissimo',
		label: 'Fortissimo',
		symbol: smufl(0xe52f),
		category: 'Dynamics',
		keywords: ['ff', 'loud', 'dynamic']
	},
	{
		id: 'pianissimo',
		label: 'Pianissimo',
		symbol: smufl(0xe52b),
		category: 'Dynamics',
		keywords: ['pp', 'soft', 'dynamic']
	},
	{
		id: 'sforzando',
		label: 'Sforzando',
		symbol: smufl(0xe524),
		category: 'Dynamics',
		keywords: ['sfz', 'dynamic', 'accent']
	},
	{
		id: 'down-bow',
		label: 'Down bow',
		symbol: smufl(0xe610),
		category: 'Bowings',
		keywords: ['down bow', 'violin', 'bow']
	},
	{
		id: 'up-bow',
		label: 'Up bow',
		symbol: smufl(0xe612),
		category: 'Bowings',
		keywords: ['up bow', 'violin', 'bow']
	},
	...[1, 2, 3, 4, 5].map((n) => ({
		id: `finger-${n}`,
		label: `Finger ${n}`,
		symbol: String(n),
		category: 'Fingering' as SymbolCategory,
		keywords: ['finger', 'fingering', String(n)]
	}))
];
export const SYMBOL_CATEGORIES: SymbolCategory[] = [
	'Common',
	'Dynamics',
	'Articulations',
	'Accidentals',
	'Repeats',
	'Bowings',
	'Fingering',
	'Holds & Pauses'
];
