export type MusicSymbol = {
	id: string;
	name: string;
	category:
		| 'Clefs'
		| 'Notes'
		| 'Rests'
		| 'Accidentals'
		| 'Articulations'
		| 'Dynamics'
		| 'Ornaments'
		| 'Pauses'
		| 'Repeats'
		| 'Bowings'
		| 'Fingering';
	glyph: string;
};

const glyph = (hex: string) => String.fromCodePoint(parseInt(hex, 16));

export const MUSIC_SYMBOLS: MusicSymbol[] = [
	['g-clef', 'G clef', 'Clefs', 'E050'],
	['c-clef', 'C clef', 'Clefs', 'E05C'],
	['f-clef', 'F clef', 'Clefs', 'E062'],
	['percussion-clef', 'Percussion clef', 'Clefs', 'E069'],
	['whole-note', 'Whole note', 'Notes', 'E0A2'],
	['half-note', 'Half note', 'Notes', 'E0A3'],
	['quarter-note', 'Quarter note', 'Notes', 'E0A4'],
	['x-note', 'X notehead', 'Notes', 'E0A9'],
	['diamond-note', 'Diamond notehead', 'Notes', 'E0DB'],
	['quarter-rest', 'Quarter rest', 'Rests', 'E4E5'],
	['eighth-rest', 'Eighth rest', 'Rests', 'E4E6'],
	['sixteenth-rest', 'Sixteenth rest', 'Rests', 'E4E7'],
	['thirtysecond-rest', '32nd rest', 'Rests', 'E4E8'],
	['flat', 'Flat', 'Accidentals', 'E260'],
	['natural', 'Natural', 'Accidentals', 'E261'],
	['sharp', 'Sharp', 'Accidentals', 'E262'],
	['double-sharp', 'Double sharp', 'Accidentals', 'E263'],
	['double-flat', 'Double flat', 'Accidentals', 'E264'],
	['accent', 'Accent', 'Articulations', 'E4A0'],
	['staccato', 'Staccato', 'Articulations', 'E4A2'],
	['tenuto', 'Tenuto', 'Articulations', 'E4A4'],
	['staccatissimo', 'Staccatissimo', 'Articulations', 'E4A6'],
	['marcato', 'Marcato', 'Articulations', 'E4AC'],
	['p', 'Piano', 'Dynamics', 'E520'],
	['pp', 'Pianissimo', 'Dynamics', 'E52B'],
	['mp', 'Mezzo-piano', 'Dynamics', 'E52C'],
	['mf', 'Mezzo-forte', 'Dynamics', 'E52D'],
	['f', 'Forte', 'Dynamics', 'E522'],
	['ff', 'Fortissimo', 'Dynamics', 'E52F'],
	['fff', 'Fortississimo', 'Dynamics', 'E530'],
	['sfz', 'Sforzando', 'Dynamics', 'E524'],
	['trill', 'Trill', 'Ornaments', 'E566'],
	['mordent', 'Mordent', 'Ornaments', 'E56C'],
	['turn', 'Turn', 'Ornaments', 'E567'],
	['inverted-turn', 'Inverted turn', 'Ornaments', 'E568'],
	['arpeggiato', 'Arpeggiato', 'Ornaments', 'E63B'],
	['fermata', 'Fermata', 'Pauses', 'E4C0'],
	['fermata-below', 'Fermata below', 'Pauses', 'E4C1'],
	['breath', 'Breath mark', 'Pauses', 'E4CE'],
	['caesura', 'Caesura', 'Pauses', 'E4D1'],
	['segno', 'Segno', 'Repeats', 'E047'],
	['coda', 'Coda', 'Repeats', 'E048'],
	['dal-segno', 'Dal segno', 'Repeats', 'E045'],
	['da-capo', 'Da capo', 'Repeats', 'E046'],
	['down-bow', 'Down bow', 'Bowings', 'E610'],
	['up-bow', 'Up bow', 'Bowings', 'E612'],
	['finger-0', 'Finger 0', 'Fingering', 'F030'], // Use hex codes for consistency
	['finger-1', 'Finger 1', 'Fingering', 'F031'],
	['finger-2', 'Finger 2', 'Fingering', 'F032'],
	['finger-3', 'Finger 3', 'Fingering', 'F033'],
	['finger-4', 'Finger 4', 'Fingering', 'F034'],
	['finger-5', 'Finger 5', 'Fingering', 'F035']
].map(([id, name, category, hex]) => ({
	id,
	name,
	category: category as MusicSymbol['category'],
	glyph: glyph(hex)
}));

export const MUSIC_SYMBOL_CATEGORIES = [
	'Clefs',
	'Notes',
	'Rests',
	'Accidentals',
	'Articulations',
	'Dynamics',
	'Ornaments',
	'Pauses',
	'Repeats',
	'Bowings',
	'Fingering'
] as const;
