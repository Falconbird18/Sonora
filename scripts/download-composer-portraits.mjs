#!/usr/bin/env node
/**
 * Download composer portraits once into public/composers/.
 *
 * Wikimedia requires a descriptive User-Agent. After this runs, the desktop
 * and web apps load local JPEGs instead of hitting Commons on every launch.
 *
 * Usage: node scripts/download-composer-portraits.mjs
 */
import { mkdir, writeFile, access } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'composers');
const UA =
	'SonoraSheetMusic/1.0 (https://github.com/Falconbird18/Sonora; sheet music library portraits)';

/** Preferred Commons file titles, then a search fallback. */
const COMPOSERS = [
	{ key: 'beethoven', files: ['Joseph Karl Stieler - Beethoven - cropped.jpg', 'Beethoven.jpg'] },
	{ key: 'mozart', files: ['Wolfgang-amadeus-mozart 1.jpg', 'Wolfgang Amadeus Mozart.jpg'] },
	{ key: 'bach', files: ['Johann Sebastian Bach.jpg', 'JSBach.jpg'] },
	{ key: 'handel', files: ['George Frideric Handel by Balthasar Denner.jpg'] },
	{ key: 'vivaldi', files: ['Antonio Vivaldi.jpg', 'Vivaldi.jpg'] },
	{ key: 'haydn', files: ['Joseph Haydn by Thomas Hardy (small).jpg', 'Joseph Haydn.jpg'] },
	{ key: 'palestrina', files: ['Giovanni Pierluigi da Palestrina.jpg'] },
	{ key: 'chopin', files: ['Frederic Chopin photo.jpeg', 'Frédéric Chopin by Bisson, 1849.png'] },
	{ key: 'brahms', files: ['Johannes Brahms 1889.jpg', 'Johannes Brahms.jpg'] },
	{ key: 'liszt', files: ['Franz Liszt 1858.jpg', 'Franz Liszt by Franz Hanfstaengl 1858.jpg'] },
	{ key: 'schubert', files: ['Franz Schubert by Wilhelm August Rieder 1875.jpg'] },
	{ key: 'mendelssohn', files: ['Felix Mendelssohn Bartholdy.jpg'] },
	{ key: 'schumann', files: ['Robert Schumann 1839.jpg', 'Robert Schumann.jpg'] },
	{ key: 'dvorak', files: ['Antonín Dvořák LOC 3c05828u.jpg', 'Antonin Dvorak.jpg'] },
	{ key: 'tchaikovsky', files: ['Tchaikovsky by Reutlinger.jpg', 'Peter Tschaikowski.jpg'] },
	{ key: 'grieg', files: ['Edvard Grieg (1888) by Elliot and Fry - 02.jpg', 'Edvard Grieg.jpg'] },
	{ key: 'rachmaninoff', files: ['Sergei Rachmaninoff cph.3a40552.jpg'] },
	{ key: 'rimski', files: ['Nikolai Rimsky-Korsakov by Repin.jpg'] },
	{ key: 'borodin', files: ['Alexander Borodin by Repin.jpg'] },
	{ key: 'mussorgsky', files: ['Modest Mussorgsky 1870.jpg', 'Modest Mussorgsky.jpg'] },
	{ key: 'prokofiev', files: ['Sergei Prokofiev circa 1918.jpg', 'Sergei Prokofiev.jpg'] },
	{ key: 'stravinsky', files: ['Igor Stravinsky LOC 32392u.jpg'] },
	{ key: 'debussy', files: ['Claude Debussy atelier Nadar.jpg', 'Claude Debussy.jpg'] },
	{ key: 'ravel', files: ['Maurice Ravel 1925.jpg'] },
	{ key: 'mahler', files: ['Gustav Mahler 1907.jpg', 'Portrait gustav mahler 1910.jpg'] },
	{ key: 'bruckner', files: ['Anton Bruckner.jpg'] },
	{ key: 'wagner', files: ['RichardWagner.jpg', 'Richard Wagner.jpg'] },
	{ key: 'verdi', files: ['Giuseppe Verdi by Giovanni Boldini.jpg', 'Giuseppe Verdi.jpg'] },
	{ key: 'puccini', files: ['Giacomo Puccini 1908.jpg', 'Giacomo Puccini by Henri Manuel.jpg'] },
	{ key: 'bartok', files: ['Bela Bartok 1927.jpg', 'Béla Bartók.jpg'] },
	{ key: 'janacek', files: ['Leos Janacek.jpg', 'Leoš Janáček.jpg'] },
	{ key: 'sibelius', files: ['Jean Sibelius, 1913.jpg'] },
	{ key: 'elgar', files: ['Edward Elgar.jpg'] },
	{ key: 'holst', files: ['Gustav Holst.jpg'] },
	{ key: 'vaughan', files: ['Ralph Vaughan Williams 1922.jpg', 'Ralph Vaughan Williams.jpg'] },
	{ key: 'gershwin', files: ['George Gershwin 1937.jpg'] }
];

async function exists(path) {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function fetchBuffer(url) {
	const res = await fetch(url, {
		headers: { 'User-Agent': UA, Accept: 'image/jpeg,image/png,image/*,*/*' },
		redirect: 'follow'
	});
	if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
	const type = res.headers.get('content-type') || '';
	if (type.includes('text/html')) throw new Error(`HTML instead of image: ${url}`);
	return Buffer.from(await res.arrayBuffer());
}

function filePathUrl(title) {
	return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title)}?width=256`;
}

async function commonsThumb(title) {
	const api = new URL('https://commons.wikimedia.org/w/api.php');
	api.searchParams.set('action', 'query');
	api.searchParams.set('titles', `File:${title}`);
	api.searchParams.set('prop', 'imageinfo');
	api.searchParams.set('iiprop', 'url');
	api.searchParams.set('iiurlwidth', '256');
	api.searchParams.set('format', 'json');
	api.searchParams.set('origin', '*');
	const res = await fetch(api, { headers: { 'User-Agent': UA } });
	if (!res.ok) throw new Error(`API ${res.status}`);
	const data = await res.json();
	const page = Object.values(data?.query?.pages || {})[0];
	const info = page?.imageinfo?.[0];
	if (!info?.thumburl && !info?.url) throw new Error(`No imageinfo for ${title}`);
	return info.thumburl || info.url;
}

async function searchCommons(key) {
	const api = new URL('https://commons.wikimedia.org/w/api.php');
	api.searchParams.set('action', 'query');
	api.searchParams.set('list', 'search');
	api.searchParams.set('srsearch', `${key} composer portrait`);
	api.searchParams.set('srnamespace', '6');
	api.searchParams.set('srlimit', '5');
	api.searchParams.set('format', 'json');
	api.searchParams.set('origin', '*');
	const res = await fetch(api, { headers: { 'User-Agent': UA } });
	if (!res.ok) throw new Error(`search ${res.status}`);
	const data = await res.json();
	const hits = data?.query?.search || [];
	for (const hit of hits) {
		const title = String(hit.title || '').replace(/^File:/i, '');
		if (!title) continue;
		try {
			return await commonsThumb(title);
		} catch {
			continue;
		}
	}
	throw new Error(`No Commons search hit for ${key}`);
}

async function downloadOne(composer) {
	const dest = join(OUT_DIR, `${composer.key}.jpg`);
	if (await exists(dest)) {
		console.log(`skip  ${composer.key}`);
		return true;
	}
	const attempts = [
		...composer.files.map((title) => () => fetchBuffer(filePathUrl(title))),
		...composer.files.map((title) => async () => fetchBuffer(await commonsThumb(title))),
		async () => fetchBuffer(await searchCommons(composer.key))
	];
	let lastError;
	for (const attempt of attempts) {
		try {
			const buf = await attempt();
			if (buf.byteLength < 800) throw new Error('Image too small');
			await writeFile(dest, buf);
			console.log(`ok    ${composer.key} (${buf.byteLength} bytes)`);
			return true;
		} catch (error) {
			lastError = error;
		}
	}
	console.warn(`fail  ${composer.key}: ${lastError?.message || lastError}`);
	return false;
}

await mkdir(OUT_DIR, { recursive: true });
let ok = 0;
for (const composer of COMPOSERS) {
	if (await downloadOne(composer)) ok += 1;
}
console.log(`\nDownloaded ${ok}/${COMPOSERS.length} portraits into public/composers/`);
if (ok === 0) process.exit(1);
