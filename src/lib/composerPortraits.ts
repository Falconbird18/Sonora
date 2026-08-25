const COMPOSER_PORTRAITS: Record<string, string> = {
  beethoven: 'https://commons.wikimedia.org/wiki/Special:FilePath/Beethoven.jpg',
  mozart: 'https://commons.wikimedia.org/wiki/Special:FilePath/Wolfgang-amadeus-mozart_1.jpg',
  bach: 'https://commons.wikimedia.org/wiki/Special:FilePath/Johann_Sebastian_Bach.jpg',
  handel: 'https://commons.wikimedia.org/wiki/Special:FilePath/George_Frideric_Handel_by_Balthasar_Denner.jpg',
  vivaldi: 'https://commons.wikimedia.org/wiki/Special:FilePath/Antonio_Vivaldi_portrait.jpg',
  haydn: 'https://commons.wikimedia.org/wiki/Special:FilePath/Joseph_Haydn_by_Thomas_Hardy_(small).jpg',
  palestrina: 'https://commons.wikimedia.org/wiki/Special:FilePath/Giovanni_Pierluigi_da_Palestrina.jpg',
  chopin: 'https://commons.wikimedia.org/wiki/Special:FilePath/Frederic_Chopin_photo.jpeg',
  brahms: 'https://commons.wikimedia.org/wiki/Special:FilePath/Johannes_Brahms_by_C._F._Schwager_1876.jpg',
  liszt: 'https://commons.wikimedia.org/wiki/Special:FilePath/Franz_Liszt_1858.jpg',
  schubert: 'https://commons.wikimedia.org/wiki/Special:FilePath/Franz_Schubert_by_Wilhelm_August_Rieder_1875.jpg',
  mendelssohn: 'https://commons.wikimedia.org/wiki/Special:FilePath/Felix_Mendelssohn_Bartholdy.jpg',
  schumann: 'https://commons.wikimedia.org/wiki/Special:FilePath/Robert_Schumann.jpg',
  dvorak: 'https://commons.wikimedia.org/wiki/Special:FilePath/Anton%C3%ADn_Dvo%C5%99%C3%A1k_LOC_3c05828u.jpg',
  tchaikovsky: 'https://commons.wikimedia.org/wiki/Special:FilePath/Tchaikovsky_by_Reutlinger.jpg',
  grieg: 'https://commons.wikimedia.org/wiki/Special:FilePath/Edvard_Grieg.jpg',
  rachmaninoff: 'https://commons.wikimedia.org/wiki/Special:FilePath/Sergei_Rachmaninoff_cph.3a40552.jpg',
  rimski: 'https://commons.wikimedia.org/wiki/Special:FilePath/Nikolai_Rimsky-Korsakov_by_Repin.jpg',
  borodin: 'https://commons.wikimedia.org/wiki/Special:FilePath/Alexander_Borodin_by_Repin.jpg',
  mussorgsky: 'https://commons.wikimedia.org/wiki/Special:FilePath/Modest_Mussorgsky.jpg',
  prokofiev: 'https://commons.wikimedia.org/wiki/Special:FilePath/Sergei_Prokofiev_02_(cropped).jpg',
  stravinsky: 'https://commons.wikimedia.org/wiki/Special:FilePath/Igor_Stravinsky_LOC_32392u.jpg',
  debussy: 'https://commons.wikimedia.org/wiki/Special:FilePath/Claude_Debussy_by_Atelier_Nadar_late_1880s_-_crop.jpg',
  ravel: 'https://commons.wikimedia.org/wiki/Special:FilePath/Maurice_Ravel_1925.jpg',
  mahler: 'https://commons.wikimedia.org/wiki/Special:FilePath/Portrait_gustav_mahler_1910.jpg',
  bruckner: 'https://commons.wikimedia.org/wiki/Special:FilePath/Anton_Bruckner.jpg',
  wagner: 'https://commons.wikimedia.org/wiki/Special:FilePath/RichardWagner.jpg',
  verdi: 'https://commons.wikimedia.org/wiki/Special:FilePath/Giuseppe_Verdi_by_Giovanni_Bolzoni.jpg',
  puccini: 'https://commons.wikimedia.org/wiki/Special:FilePath/Giacomo_Puccini_by_Henri_Manuel.jpg',
  bartok: 'https://commons.wikimedia.org/wiki/Special:FilePath/Bela_Bartok_1927.jpg',
  janacek: 'https://commons.wikimedia.org/wiki/Special:FilePath/Leos_Janacek.jpg',
  sibelius: 'https://commons.wikimedia.org/wiki/Special:FilePath/Jean_Sibelius,_1913.jpg',
  elgar: 'https://commons.wikimedia.org/wiki/Special:FilePath/Edward_Elgar.jpg',
  holst: 'https://commons.wikimedia.org/wiki/Special:FilePath/Gustav_Holst.jpg',
  vaughan: 'https://commons.wikimedia.org/wiki/Special:FilePath/Ralph_Vaughan_Williams.jpg',
  gershwin: 'https://commons.wikimedia.org/wiki/Special:FilePath/George_Gershwin_1937.jpg'
};

const ALIASES: Record<string, string> = {
  johannsebastian: 'bach', georgefrideric: 'handel', joseph: 'haydn', antonin: 'dvorak',
  sergei: 'rachmaninoff', nikolai: 'rimski', maurice: 'ravel', gustav: 'mahler',
  igor: 'stravinsky', bela: 'bartok', jean: 'sibelius', ralph: 'vaughan', jsbach: 'bach',
  johannsebastianbach: 'bach', georgefriderichandel: 'handel', franzschubert: 'schubert',
  franzliszt: 'liszt', felixmendelssohn: 'mendelssohn', robertschumann: 'schumann',
  antonindvorak: 'dvorak', sergeirachmaninoff: 'rachmaninoff', nikolairimskykorsakov: 'rimski',
  mauriceravel: 'ravel', gustavmahler: 'mahler', ralphvaughanwilliams: 'vaughan',
  jeansibelius: 'sibelius'
};

function normalize(value: string) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export function getComposerPortrait(name: string) {
  const normalized = normalize(name);
  if (!normalized) return '';
  if (COMPOSER_PORTRAITS[normalized]) return COMPOSER_PORTRAITS[normalized];
  if (ALIASES[normalized]) return COMPOSER_PORTRAITS[ALIASES[normalized]];
  const words = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  for (const word of words) if (COMPOSER_PORTRAITS[word]) return COMPOSER_PORTRAITS[word];
  for (const [alias, key] of Object.entries(ALIASES)) if (normalized.includes(alias)) return COMPOSER_PORTRAITS[key];
  return '';
}
