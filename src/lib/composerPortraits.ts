const COMPOSER_PORTRAITS: Record<string, string> = {
	beethoven:
		'https://upload.wikimedia.org/wikipedia/commons/6/6f/Beethoven.jpg',
	mozart:
		'https://upload.wikimedia.org/wikipedia/commons/1/1e/Wolfgang-amadeus-mozart_1.jpg',
	bach: 'https://upload.wikimedia.org/wikipedia/commons/6/6a/Johann_Sebastian_Bach.jpg',
	chopin:
		'https://upload.wikimedia.org/wikipedia/commons/e/e8/Frederic_Chopin_photo.jpeg',
	brahms:
		'https://upload.wikimedia.org/wikipedia/commons/1/15/JohannesBrahms.jpg',
	tchaikovsky:
		'https://upload.wikimedia.org/wikipedia/commons/d/d4/Tchaikovsky_by_Reutlinger.jpg',
	rachmaninoff:
		'https://upload.wikimedia.org/wikipedia/commons/a/a2/Sergei_Rachmaninoff_cph.3a40552.jpg',
	debussy:
		'https://upload.wikimedia.org/wikipedia/commons/1/1a/Claude_Debussy_by_Atelier_Nadar_late_1880s_-_crop.jpg',
	liszt:
		'https://upload.wikimedia.org/wikipedia/commons/4/42/Franz_Liszt_1858.jpg',
	schubert:
		'https://upload.wikimedia.org/wikipedia/commons/0/0d/Franz_Schubert_by_Wilhelm_August_Rieder_1875.jpg',
	vivaldi:
		'https://upload.wikimedia.org/wikipedia/commons/b/ba/Antonio_Vivaldi_portrait.jpg'
};

export function getComposerPortrait(composerName: string): string {
	const normalized = composerName.toLowerCase().trim();
	for (const [key, url] of Object.entries(COMPOSER_PORTRAITS)) {
		if (normalized.includes(key)) return url;
	}
	// Fallback avatar using initials
	return `https://ui-avatars.com/api/?name=${encodeURIComponent(composerName)}&background=262626&color=fff&size=128`;
}
