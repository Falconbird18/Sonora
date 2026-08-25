const COMPOSER_PORTRAITS: Record<string, string> = {
	beethoven: 'https://upload.wikimedia.org/wikipedia/commons/6/6f/Beethoven.jpg',
	mozart: 'https://upload.wikimedia.org/wikipedia/commons/1/1e/Wolfgang-amadeus-mozart_1.jpg',
	bach: 'https://upload.wikimedia.org/wikipedia/commons/6/6f/Johann_Sebastian_Bach.jpg',
	handel: 'https://upload.wikimedia.org/wikipedia/commons/8/86/George_Frideric_Handel_by_Balthasar_Denner.jpg',
	vivaldi: 'https://upload.wikimedia.org/wikipedia/commons/b/ba/Antonio_Vivaldi_portrait.jpg',
	haydn: 'https://upload.wikimedia.org/wikipedia/commons/9/96/Joseph_Haydn_by_Thomas_Hardy_%28small%29.jpg',
	gluck: 'https://upload.wikimedia.org/wikipedia/commons/0/0f/Christoph_Willibald_Gluck_by_Joseph_Siffred_Duplessis.jpg',
	palestrina: 'https://upload.wikimedia.org/wikipedia/commons/6/67/Giovanni_Pierluigi_da_Palestrina.jpg',
	chopin: 'https://upload.wikimedia.org/wikipedia/commons/3/33/Frederic_Chopin_photo.jpeg',
	brahms: 'https://upload.wikimedia.org/wikipedia/commons/1/1f/Johannes_Brahms_by_C._F._Schwager_1876.jpg',
	liszt: 'https://upload.wikimedia.org/wikipedia/commons/4/42/Franz_Liszt_1858.jpg',
	schubert: 'https://upload.wikimedia.org/wikipedia/commons/0/0d/Franz_Schubert_by_Wilhelm_August_Rieder_1875.jpg',
	mendelssohn: 'https://upload.wikimedia.org/wikipedia/commons/4/4e/Felix_Mendelssohn_Bartholdy.jpg',
	schumann: 'https://upload.wikimedia.org/wikipedia/commons/8/8b/Robert_Schumann.jpg',
	dvorak: 'https://upload.wikimedia.org/wikipedia/commons/2/2f/Anton%C3%ADn_Dvo%C5%99%C3%A1k_LOC_3c05828u.jpg',
	tchaikovsky: 'https://upload.wikimedia.org/wikipedia/commons/a/a2/Tchaikovsky_by_Reutlinger.jpg',
	grieg: 'https://upload.wikimedia.org/wikipedia/commons/3/3b/Edvard_Grieg.jpg',
	rachmaninoff: 'https://upload.wikimedia.org/wikipedia/commons/a/a2/Sergei_Rachmaninoff_cph.3a40552.jpg',
	rimski: 'https://upload.wikimedia.org/wikipedia/commons/5/5d/Nikolai_Rimsky-Korsakov_by_Repin.jpg',
	borodin: 'https://upload.wikimedia.org/wikipedia/commons/4/47/Alexander_Borodin_by_Repin.jpg',
	mussorgsky: 'https://upload.wikimedia.org/wikipedia/commons/7/79/Modest_Mussorgsky.jpg',
	prokofiev: 'https://commons.wikimedia.org/wiki/Special:FilePath/Sergei_Prokofiev_02_(cropped).jpg',
	stravinsky: 'https://commons.wikimedia.org/wiki/Special:FilePath/Igor_Stravinsky_LOC_32392u.jpg',
	debussy: 'https://upload.wikimedia.org/wikipedia/commons/1/1a/Claude_Debussy_by_Atelier_Nadar_late_1880s_-_crop.jpg',
	ravel: 'https://commons.wikimedia.org/wiki/Special:FilePath/Maurice_Ravel_1925.jpg',
	mahler: 'https://commons.wikimedia.org/wiki/Special:FilePath/Portrait_gustav_mahler_1910.jpg',
	bruckner: 'https://commons.wikimedia.org/wiki/Special:FilePath/Anton_Bruckner.jpg',
	wagner: 'https://commons.wikimedia.org/wiki/Special:FilePath/RichardWagner.jpg',
	verdi: 'https://upload.wikimedia.org/wikipedia/commons/0/0f/Giuseppe_Verdi_by_Giovanni_Bolzoni.jpg',
	puccini: 'https://upload.wikimedia.org/wikipedia/commons/5/5b/Giacomo_Puccini_by_Henri_Manuel.jpg',
	bartok: 'https://upload.wikimedia.org/wikipedia/commons/3/3c/Bela_Bartok_1927.jpg',
	janacek: 'https://commons.wikimedia.org/wiki/Special:FilePath/Leos_Janacek.jpg',
	sibelius: 'https://upload.wikimedia.org/wikipedia/commons/2/2b/Jean_Sibelius%2C_1913.jpg',
	elgar: 'https://upload.wikimedia.org/wikipedia/commons/8/83/Edward_Elgar.jpg',
	holst: 'https://upload.wikimedia.org/wikipedia/commons/0/0a/Gustav_Holst.jpg',
	vaughan: 'https://commons.wikimedia.org/wiki/Special:FilePath/Ralph_Vaughan_Williams.jpg',
	gershwin: 'https://upload.wikimedia.org/wikipedia/commons/8/86/George_Gershwin_1937.jpg'
};

export function getComposerPortrait(name: string) {
	const normalized = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
	const aliases: Record<string, string> = {
		'johann sebastian': 'bach',
		'george frideric': 'handel',
		'joseph': 'haydn',
		'antonin': 'dvorak',
		'sergei': 'rachmaninoff',
		'nikolai': 'rimski',
		'maurice': 'travel',
		'gustav': 'mahler',
		'igor': 'stravinsky',
		'bela': 'bartok',
		'jean': 'sibelius',
		'ralph': 'vaughan'
	};
	const key = Object.keys(COMPOSER_PORTRAITS).find((candidate) => normalized.includes(candidate))
		|| Object.entries(aliases).find(([alias]) => normalized.includes(alias))?.[1];
	return key ? COMPOSER_PORTRAITS[key] : '';
}
