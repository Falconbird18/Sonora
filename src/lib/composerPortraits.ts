const COMPOSER_PORTRAITS: Record<string, string> = {
	beethoven: 'https://upload.wikimedia.org/wikipedia/commons/6/6f/Beethoven.jpg',
	mozart: 'https://upload.wikimedia.org/wikipedia/commons/1/1e/Wolfgang-amadeus-mozart_1.jpg',
	bach: 'https://upload.wikimedia.org/wikipedia/commons/6/6f/Johann_Sebastian_Bach.jpg',
	chopin: 'https://upload.wikimedia.org/wikipedia/commons/3/33/Frederic_Chopin_photo.jpeg',
	brahms: 'https://upload.wikimedia.org/wikipedia/commons/1/1f/Johannes_Brahms_by_C._F._Schwager_1876.jpg',
	tchaikovsky: 'https://upload.wikimedia.org/wikipedia/commons/a/a2/Tchaikovsky_by_Reutlinger.jpg',
	rachmaninoff: 'https://upload.wikimedia.org/wikipedia/commons/a/a2/Sergei_Rachmaninoff_cph.3a40552.jpg',
	debussy: 'https://upload.wikimedia.org/wikipedia/commons/1/1a/Claude_Debussy_by_Atelier_Nadar_late_1880s_-_crop.jpg',
	liszt: 'https://upload.wikimedia.org/wikipedia/commons/4/42/Franz_Liszt_1858.jpg',
	schubert: 'https://upload.wikimedia.org/wikipedia/commons/0/0d/Franz_Schubert_by_Wilhelm_August_Rieder_1875.jpg',
	vivaldi: 'https://upload.wikimedia.org/wikipedia/commons/b/ba/Antonio_Vivaldi_portrait.jpg',
	mendelssohn: 'https://upload.wikimedia.org/wikipedia/commons/4/4e/Felix_Mendelssohn_Bartholdy.jpg',
	schumann: 'https://upload.wikimedia.org/wikipedia/commons/8/8b/Robert_Schumann.jpg',
	dvorak: 'https://upload.wikimedia.org/wikipedia/commons/2/2f/Anton%C3%ADn_Dvo%C5%99%C3%A1k_LOC_3c05828u.jpg',
	handel: 'https://upload.wikimedia.org/wikipedia/commons/8/86/George_Frideric_Handel_by_Balthasar_Denner.jpg'
};

export function getComposerPortrait(name: string) {
	const normalized = name.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
	const key = Object.keys(COMPOSER_PORTRAITS).find((candidate) => normalized.includes(candidate));
	return key ? COMPOSER_PORTRAITS[key] : '';
}
