const COMPOSER_KEYS = [
	'beethoven',
	'mozart',
	'bach',
	'handel',
	'vivaldi',
	'haydn',
	'palestrina',
	'chopin',
	'brahms',
	'liszt',
	'schubert',
	'mendelssohn',
	'schumann',
	'dvorak',
	'tchaikovsky',
	'grieg',
	'rachmaninoff',
	'rimski',
	'borodin',
	'mussorgsky',
	'prokofiev',
	'stravinsky',
	'debussy',
	'ravel',
	'mahler',
	'bruckner',
	'wagner',
	'verdi',
	'puccini',
	'bartok',
	'janacek',
	'sibelius',
	'elgar',
	'holst',
	'vaughan',
	'gershwin'
] as const;

type ComposerKey = (typeof COMPOSER_KEYS)[number];

const COMPOSER_PORTRAITS: Record<ComposerKey, string> = Object.fromEntries(
	COMPOSER_KEYS.map((key) => [key, `/composers/${key}.jpg`])
) as Record<ComposerKey, string>;

const ALIASES: Record<string, ComposerKey> = {
	johannsebastian: 'bach',
	georgefrideric: 'handel',
	joseph: 'haydn',
	antonio: 'vivaldi',
	antonin: 'dvorak',
	sergei: 'rachmaninoff',
	nikolai: 'rimski',
	maurice: 'ravel',
	gustav: 'mahler',
	igor: 'stravinsky',
	bela: 'bartok',
	jean: 'sibelius',
	ralph: 'vaughan',
	jsbach: 'bach',
	johannsebastianbach: 'bach',
	georgefriderichandel: 'handel',
	franzschubert: 'schubert',
	franzliszt: 'liszt',
	felixmendelssohn: 'mendelssohn',
	robertschumann: 'schumann',
	antonindvorak: 'dvorak',
	sergeirachmaninoff: 'rachmaninoff',
	nikolairimskykorsakov: 'rimski',
	mauriceravel: 'ravel',
	gustavmahler: 'mahler',
	ralphvaughanwilliams: 'vaughan',
	jeansibelius: 'sibelius',
	rimsky: 'rimski',
	rimskykorsakov: 'rimski',
	pyotr: 'tchaikovsky',
	peter: 'tchaikovsky',
	tchaikovski: 'tchaikovsky',
	vaughanwilliams: 'vaughan',
	leos: 'janacek',
	giuseppe: 'verdi',
	giacomo: 'puccini',
	richard: 'wagner',
	claude: 'debussy',
	edvard: 'grieg',
	edward: 'elgar',
	modest: 'mussorgsky',
	alexander: 'borodin',
	frederic: 'chopin',
	fryderyk: 'chopin',
	wolfgang: 'mozart',
	ludwig: 'beethoven',
	ludwigvanbeethoven: 'beethoven',
	wolfgangamadeusmozart: 'mozart'
};

function normalize(value: string) {
	return value
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '');
}

function portraitUrl(key: ComposerKey) {
	return COMPOSER_PORTRAITS[key];
}

export function getComposerPortrait(name: string) {
	const normalized = normalize(name);
	if (!normalized) return '';

	const words = name
		.normalize('NFD')
		.replace(/[\u0300-\u036f]/g, '')
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);

	for (const word of [...words].reverse()) {
		if (word in COMPOSER_PORTRAITS) return portraitUrl(word as ComposerKey);
	}

	if (normalized in COMPOSER_PORTRAITS) return portraitUrl(normalized as ComposerKey);
	if (ALIASES[normalized]) return portraitUrl(ALIASES[normalized]);
	for (const [alias, key] of Object.entries(ALIASES)) {
		if (normalized.includes(alias)) return portraitUrl(key);
	}
	return '';
}
