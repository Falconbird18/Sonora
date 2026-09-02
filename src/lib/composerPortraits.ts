export const COMPOSER_KEYS = [
  // Renaissance & Baroque
  'palestrina',
  'tallis',
  'byrd',
  'monteverdi',
  'schutz',
  'lully',
  'purcell',
  'corelli',
  'couperin',
  'vivaldi',
  'telemann',
  'bach',
  'handel',
  'scarlatti',
  'rameau',
  'tartini',

  // Classical
  'gluck',
  'haydn',
  'mozart',
  'beethoven',
  'paganini',
  'clementi',
  'czerny',

  // Pedagogical & Violin Technique
  'schradieck',
  'sevcik',
  'kreutzer',
  'fiorillo',
  'rode',
  'dont',
  'kayser',

  // Romantic
  'schubert',
  'berlioz',
  'mendelssohn',
  'chopin',
  'schumann',
  'liszt',
  'verdi',
  'wagner',
  'bruckner',
  'brahms',
  'saint-saens',
  'tchaikovsky',
  'dvorak',
  'grieg',
  'sarasate',
  'wieniawski',
  'rimski',
  'borodin',
  'mussorgsky',
  'elgar',
  'mahler',
  'strauss',
  'sibelius',

  // Post-Romantic & Virtuoso
  'rachmaninoff',
  'kreisler',
  'ysaye',

  // Impressionist & 20th Century
  'debussy',
  'satie',
  'holst',
  'vaughan',
  'ravel',
  'falla',
  'bartok',
  'stravinsky',
  'webern',
  'berg',
  'prokofiev',
  'hindemith',
  'gershwin',
  'poulenc',
  'copland',
  'shostakovich',
  'barber',
  'britten',
  'janacek',
  'puccini'
] as const;

export type ComposerKey = (typeof COMPOSER_KEYS)[number];

export interface ComposerData {
  key: ComposerKey;
  displayName: string;
  portraitUrl: string;
}

const COMPOSER_NAMES: Record<ComposerKey, string> = {
  palestrina: 'Giovanni Pierluigi da Palestrina',
  tallis: 'Thomas Tallis',
  byrd: 'William Byrd',
  monteverdi: 'Claudio Monteverdi',
  schutz: 'Heinrich Schütz',
  lully: 'Jean-Baptiste Lully',
  purcell: 'Henry Purcell',
  corelli: 'Arcangelo Corelli',
  couperin: 'François Couperin',
  vivaldi: 'Antonio Vivaldi',
  telemann: 'Georg Philipp Telemann',
  bach: 'Johann Sebastian Bach',
  handel: 'George Frideric Handel',
  scarlatti: 'Domenico Scarlatti',
  rameau: 'Jean-Philippe Rameau',
  tartini: 'Giuseppe Tartini',
  gluck: 'Christoph Willibald Gluck',
  haydn: 'Joseph Haydn',
  mozart: 'Wolfgang Amadeus Mozart',
  beethoven: 'Ludwig van Beethoven',
  paganini: 'Niccolò Paganini',
  clementi: 'Muzio Clementi',
  czerny: 'Carl Czerny',
  schradieck: 'Henry Schradieck',
  sevcik: 'Otakar Ševčík',
  kreutzer: 'Rodolphe Kreutzer',
  fiorillo: 'Federigo Fiorillo',
  rode: 'Pierre Rode',
  dont: 'Jakob Dont',
  kayser: 'Heinrich Ernst Kayser',
  schubert: 'Franz Schubert',
  berlioz: 'Hector Berlioz',
  mendelssohn: 'Felix Mendelssohn',
  chopin: 'Frédéric Chopin',
  schumann: 'Robert Schumann',
  liszt: 'Franz Liszt',
  verdi: 'Giuseppe Verdi',
  wagner: 'Richard Wagner',
  bruckner: 'Anton Bruckner',
  brahms: 'Johannes Brahms',
  'saint-saens': 'Camille Saint-Saëns',
  tchaikovsky: 'Pyotr Ilyich Tchaikovsky',
  dvorak: 'Antonín Dvořák',
  grieg: 'Edvard Grieg',
  sarasate: 'Pablo de Sarasate',
  wieniawski: 'Henryk Wieniawski',
  rimski: 'Nikolai Rimsky-Korsakov',
  borodin: 'Alexander Borodin',
  mussorgsky: 'Modest Mussorgsky',
  elgar: 'Edward Elgar',
  mahler: 'Gustav Mahler',
  strauss: 'Richard Strauss',
  sibelius: 'Jean Sibelius',
  rachmaninoff: 'Sergei Rachmaninoff',
  kreisler: 'Fritz Kreisler',
  ysaye: 'Eugène Ysaÿe',
  debussy: 'Claude Debussy',
  satie: 'Erik Satie',
  holst: 'Gustav Holst',
  vaughan: 'Ralph Vaughan Williams',
  ravel: 'Maurice Ravel',
  falla: 'Manuel de Falla',
  bartok: 'Béla Bartók',
  stravinsky: 'Igor Stravinsky',
  webern: 'Anton Webern',
  berg: 'Alban Berg',
  prokofiev: 'Sergei Prokofiev',
  hindemith: 'Paul Hindemith',
  gershwin: 'George Gershwin',
  poulenc: 'Francis Poulenc',
  copland: 'Aaron Copland',
  shostakovich: 'Dmitri Shostakovich',
  barber: 'Samuel Barber',
  britten: 'Benjamin Britten',
  janacek: 'Leoš Janáček',
  puccini: 'Giacomo Puccini'
};

const COMPOSER_PORTRAITS: Record<ComposerKey, string> = Object.fromEntries(
  COMPOSER_KEYS.map((key) => [key, `/composers/${key}.jpg`])
) as Record<ComposerKey, string>;

const ALIASES: Record<string, ComposerKey> = {
  // Schradieck variations
  shradiak: 'schradieck',
  schradiak: 'schradieck',
  shradieck: 'schradieck',
  henryschradieck: 'schradieck',

  // Ševčík variations
  sevik: 'sevcik',
  sevcik: 'sevcik',
  sevcikotakar: 'sevcik',
  otakarsevcik: 'sevcik',
  otakar: 'sevcik',

  // Classical & Romantic standard aliases
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
  wolfgangamadeusmozart: 'mozart',

  // Additional major composer aliases
  niccolo: 'paganini',
  niccolopaganini: 'paganini',
  dmitri: 'shostakovich',
  dmitrishostakovich: 'shostakovich',
  fritz: 'kreisler',
  fritzkreisler: 'kreisler',
  eugene: 'ysaye',
  eugeneysaye: 'ysaye',
  henryk: 'wieniawski',
  henrykwieniawski: 'wieniawski',
  pablo: 'sarasate',
  pablodesarasate: 'sarasate',
  camille: 'saint-saens',
  camillesaintsaens: 'saint-saens',
  saintsaens: 'saint-saens'
};

const SORTED_ALIASES = Object.entries(ALIASES).sort(
  ([a], [b]) => b.length - a.length
);

export function normalize(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

export function resolveComposerKey(name: string): ComposerKey | null {
  const normalized = normalize(name);
  if (!normalized) return null;

  // 1. Direct key match
  if (COMPOSER_KEYS.includes(normalized as ComposerKey)) {
    return normalized as ComposerKey;
  }

  // 2. Direct alias match
  if (normalized in ALIASES) {
    return ALIASES[normalized];
  }

  // 3. Word-level evaluation (checks right-to-left for last names first)
  const words = name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

  for (const word of [...words].reverse()) {
    if (COMPOSER_KEYS.includes(word as ComposerKey)) return word as ComposerKey;
    if (word in ALIASES) return ALIASES[word];
  }

  // 4. Multi-word substring check (ordered by longest alias first)
  for (const [alias, key] of SORTED_ALIASES) {
    if (normalized.includes(alias)) return key;
  }

  return null;
}

export function getComposerData(name: string): ComposerData | null {
  const key = resolveComposerKey(name);
  if (!key) return null;

  return {
    key,
    displayName: COMPOSER_NAMES[key],
    portraitUrl: COMPOSER_PORTRAITS[key]
  };
}

export function getComposerPortrait(name: string): string {
  return getComposerData(name)?.portraitUrl ?? '';
}
