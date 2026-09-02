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

/** Preferred Commons file titles, with search fallbacks for each composer. */
const COMPOSERS = [
    // Renaissance & Baroque
    { key: 'palestrina', files: ['Giovanni Pierluigi da Palestrina.jpg'] },
    { key: 'tallis', files: ['Thomas Tallis.jpg'], query: 'Thomas Tallis portrait' },
    { key: 'byrd', files: ['William Byrd.jpg'], query: 'William Byrd portrait' },
    { key: 'monteverdi', files: ['Claudio Monteverdi.jpg'] },
    { key: 'schutz', files: ['Heinrich Schütz.jpg', 'Heinrich Schutz.jpg'] },
    { key: 'lully', files: ['Jean-Baptiste Lully.jpg'] },
    { key: 'purcell', files: ['Henry Purcell.jpg'] },
    { key: 'corelli', files: ['Arcangelo Corelli.jpg'] },
    { key: 'couperin', files: ['François Couperin.jpg', 'Francois Couperin.jpg'] },
    { key: 'vivaldi', files: ['Antonio Vivaldi.jpg', 'Vivaldi.jpg'] },
    { key: 'telemann', files: ['Georg Philipp Telemann.jpg'] },
    { key: 'bach', files: ['Johann Sebastian Bach.jpg', 'JSBach.jpg'] },
    { key: 'handel', files: ['George Frideric Handel by Balthasar Denner.jpg'] },
    { key: 'scarlatti', files: ['Domenico Scarlatti.jpg'] },
    { key: 'rameau', files: ['Jean-Philippe Rameau.jpg'] },
    { key: 'tartini', files: ['Giuseppe Tartini.jpg'] },

    // Classical
    { key: 'gluck', files: ['Christoph Willibald Gluck.jpg'] },
    { key: 'haydn', files: ['Joseph Haydn by Thomas Hardy (small).jpg', 'Joseph Haydn.jpg'] },
    { key: 'mozart', files: ['Wolfgang-amadeus-mozart 1.jpg', 'Wolfgang Amadeus Mozart.jpg'] },
    { key: 'beethoven', files: ['Joseph Karl Stieler - Beethoven - cropped.jpg', 'Beethoven.jpg'] },
    { key: 'paganini', files: ['NiccoloPaganini.jpg', 'Niccolò Paganini.jpg'] },
    { key: 'clementi', files: ['Muzio Clementi.jpg'] },
    { key: 'czerny', files: ['Carl Czerny.jpg'] },

    // Pedagogical & Violin Technique
    { key: 'schradieck', files: ['Henry Schradieck.jpg'], query: 'Henry Schradieck portrait' },
    { key: 'sevcik', files: ['Otakar Ševčík.jpg', 'Otakar Sevcik.jpg'], query: 'Otakar Sevcik composer' },
    { key: 'kreutzer', files: ['Rodolphe Kreutzer.jpg'] },
    { key: 'fiorillo', files: ['Federigo Fiorillo.jpg'] },
    { key: 'rode', files: ['Pierre Rode.jpg'] },
    { key: 'dont', files: ['Jakob Dont.jpg'], query: 'Jakob Dont portrait' },
    { key: 'kayser', files: ['Heinrich Ernst Kayser.jpg'], query: 'Heinrich Ernst Kayser portrait' },

    // Romantic
    { key: 'schubert', files: ['Franz Schubert by Wilhelm August Rieder 1875.jpg'] },
    { key: 'berlioz', files: ['Hector Berlioz.jpg'] },
    { key: 'mendelssohn', files: ['Felix Mendelssohn Bartholdy.jpg'] },
    { key: 'chopin', files: ['Frederic Chopin photo.jpeg', 'Frédéric Chopin by Bisson, 1849.png'] },
    { key: 'schumann', files: ['Robert Schumann 1839.jpg', 'Robert Schumann.jpg'] },
    { key: 'liszt', files: ['Franz Liszt 1858.jpg', 'Franz Liszt by Franz Hanfstaengl 1858.jpg'] },
    { key: 'verdi', files: ['Giuseppe Verdi by Giovanni Boldini.jpg', 'Giuseppe Verdi.jpg'] },
    { key: 'wagner', files: ['RichardWagner.jpg', 'Richard Wagner.jpg'] },
    { key: 'bruckner', files: ['Anton Bruckner.jpg'] },
    { key: 'brahms', files: ['Johannes Brahms 1889.jpg', 'Johannes Brahms.jpg'] },
    { key: 'saint-saens', files: ['Camille Saint-Saëns.jpg', 'Camille Saint-Saens.jpg'], query: 'Camille Saint-Saens portrait' },
    { key: 'tchaikovsky', files: ['Tchaikovsky by Reutlinger.jpg', 'Peter Tschaikowski.jpg'] },
    { key: 'dvorak', files: ['Antonín Dvořák LOC 3c05828u.jpg', 'Antonin Dvorak.jpg'] },
    { key: 'grieg', files: ['Edvard Grieg (1888) by Elliot and Fry - 02.jpg', 'Edvard Grieg.jpg'] },
    { key: 'sarasate', files: ['Pablo de Sarasate.jpg'] },
    { key: 'wieniawski', files: ['Henryk Wieniawski.jpg'] },
    { key: 'rimski', files: ['Nikolai Rimsky-Korsakov by Repin.jpg'] },
    { key: 'borodin', files: ['Alexander Borodin by Repin.jpg'] },
    { key: 'mussorgsky', files: ['Modest Mussorgsky 1870.jpg', 'Modest Mussorgsky.jpg'] },
    { key: 'elgar', files: ['Edward Elgar.jpg'] },
    { key: 'mahler', files: ['Gustav Mahler 1907.jpg', 'Portrait gustav mahler 1910.jpg'] },
    { key: 'strauss', files: ['Richard Strauss 1918.jpg', 'Richard Strauss.jpg'], query: 'Richard Strauss portrait' },
    { key: 'sibelius', files: ['Jean Sibelius, 1913.jpg'] },

    // Post-Romantic & Virtuoso
    { key: 'rachmaninoff', files: ['Sergei Rachmaninoff cph.3a40552.jpg'] },
    { key: 'kreisler', files: ['Fritz Kreisler.jpg'] },
    { key: 'ysaye', files: ['Eugene Ysaye.jpg', 'Eugène Ysaÿe.jpg'] },

    // Impressionist & 20th Century
    { key: 'debussy', files: ['Claude Debussy atelier Nadar.jpg', 'Claude Debussy.jpg'] },
    { key: 'satie', files: ['Erik Satie.jpg'] },
    { key: 'holst', files: ['Gustav Holst.jpg'] },
    { key: 'vaughan', files: ['Ralph Vaughan Williams 1922.jpg', 'Ralph Vaughan Williams.jpg'], query: 'Ralph Vaughan Williams portrait' },
    { key: 'ravel', files: ['Maurice Ravel 1925.jpg'] },
    { key: 'falla', files: ['Manuel de Falla.jpg'] },
    { key: 'bartok', files: ['Bela Bartok 1927.jpg', 'Béla Bartók.jpg'] },
    { key: 'stravinsky', files: ['Igor Stravinsky LOC 32392u.jpg'] },
    { key: 'webern', files: ['Anton Webern.jpg'] },
    { key: 'berg', files: ['Alban Berg.jpg'] },
    { key: 'prokofiev', files: ['Sergei Prokofiev circa 1918.jpg', 'Sergei Prokofiev.jpg'] },
    { key: 'hindemith', files: ['Paul Hindemith.jpg'] },
    { key: 'gershwin', files: ['George Gershwin 1937.jpg'] },
    { key: 'poulenc', files: ['Francis Poulenc.jpg'] },
    { key: 'copland', files: ['Aaron Copland.jpg'] },
    { key: 'shostakovich', files: ['Dmitri Shostakovich.jpg'] },
    { key: 'barber', files: ['Samuel Barber.jpg'] },
    { key: 'britten', files: ['Benjamin Britten.jpg'] },
    { key: 'janacek', files: ['Leos Janacek.jpg', 'Leoš Janáček.jpg'] },
    { key: 'puccini', files: ['Giacomo Puccini 1908.jpg', 'Giacomo Puccini by Henri Manuel.jpg'] }
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

async function searchCommons(composer) {
    const searchQuery = composer.query || `${composer.key} composer portrait`;
    const api = new URL('https://commons.wikimedia.org/w/api.php');
    api.searchParams.set('action', 'query');
    api.searchParams.set('list', 'search');
    api.searchParams.set('srsearch', searchQuery);
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
    throw new Error(`No Commons search hit for ${composer.key}`);
}

async function downloadOne(composer) {
    const dest = join(OUT_DIR, `${composer.key}.jpg`);
    if (await exists(dest)) {
        console.log(`skip   ${composer.key}`);
        return true;
    }
    const attempts = [
        ...composer.files.map((title) => () => fetchBuffer(filePathUrl(title))),
        ...composer.files.map((title) => async () => fetchBuffer(await commonsThumb(title))),
        async () => fetchBuffer(await searchCommons(composer))
    ];
    let lastError;
    for (const attempt of attempts) {
        try {
            const buf = await attempt();
            if (buf.byteLength < 800) throw new Error('Image too small');
            await writeFile(dest, buf);
            console.log(`ok     ${composer.key} (${buf.byteLength} bytes)`);
            return true;
        } catch (error) {
            lastError = error;
        }
    }
    console.warn(`fail   ${composer.key}: ${lastError?.message || lastError}`);
    return false;
}

await mkdir(OUT_DIR, { recursive: true });
let ok = 0;
for (const composer of COMPOSERS) {
    if (await downloadOne(composer)) ok += 1;
}
console.log(`\nDownloaded ${ok}/${COMPOSERS.length} portraits into public/composers/`);
if (ok === 0) process.exit(1);
