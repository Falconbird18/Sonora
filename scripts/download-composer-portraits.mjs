#!/usr/bin/env node
/** Download composer portraits defined by src/data/composers.json. */
import { mkdir, writeFile, access, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = join(ROOT, 'public', 'composers');
const DATABASE = join(ROOT, 'src', 'data', 'composers.json');
const UA = 'SonoraSheetMusic/1.0 (https://github.com/Falconbird18/Sonora; sheet music library portraits)';
const COMPOSERS = JSON.parse(await readFile(DATABASE, 'utf8'));

async function exists(path) { try { await access(path); return true; } catch { return false; } }
async function fetchBuffer(url) {
	const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'image/jpeg,image/png,image/*,*/*' }, redirect: 'follow' });
	if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`);
	if ((res.headers.get('content-type') || '').includes('text/html')) throw new Error(`HTML instead of image: ${url}`);
	return Buffer.from(await res.arrayBuffer());
}
function filePathUrl(title) { return `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(title)}?width=256`; }
async function commonsThumb(title) {
	const api = new URL('https://commons.wikimedia.org/w/api.php');
	for (const [key, value] of Object.entries({ action: 'query', titles: `File:${title}`, prop: 'imageinfo', iiprop: 'url', iiurlwidth: '256', format: 'json', origin: '*' })) api.searchParams.set(key, value);
	const res = await fetch(api, { headers: { 'User-Agent': UA } });
	if (!res.ok) throw new Error(`API ${res.status}`);
	const data = await res.json(); const page = Object.values(data?.query?.pages || {})[0]; const info = page?.imageinfo?.[0];
	if (!info?.thumburl && !info?.url) throw new Error(`No imageinfo for ${title}`);
	return info.thumburl || info.url;
}
async function searchCommons(composer) {
	const api = new URL('https://commons.wikimedia.org/w/api.php');
	for (const [key, value] of Object.entries({ action: 'query', list: 'search', srsearch: composer.portraitQuery || `${composer.name} portrait`, srnamespace: '6', srlimit: '5', format: 'json', origin: '*' })) api.searchParams.set(key, value);
	const res = await fetch(api, { headers: { 'User-Agent': UA } }); if (!res.ok) throw new Error(`search ${res.status}`); const data = await res.json();
	for (const hit of data?.query?.search || []) { const title = String(hit.title || '').replace(/^File:/i, ''); if (!title) continue; try { return await commonsThumb(title); } catch {} }
	throw new Error(`No Commons search hit for ${composer.id}`);
}
async function downloadOne(composer) {
	const dest = join(OUT_DIR, `${composer.id}.jpg`); if (await exists(dest)) { console.log(`skip   ${composer.id}`); return true; }
	const attempts = [
		...(composer.portraitFiles || []).map((title) => () => fetchBuffer(filePathUrl(title))),
		...(composer.portraitFiles || []).map((title) => async () => fetchBuffer(await commonsThumb(title))),
		async () => fetchBuffer(await searchCommons(composer))
	];
	for (const attempt of attempts) { try { const buf = await attempt(); if (buf.byteLength < 800) throw new Error('Image too small'); await writeFile(dest, buf); console.log(`ok     ${composer.id} (${buf.byteLength} bytes)`); return true; } catch (error) { console.warn(`retry  ${composer.id}: ${error?.message || error}`); } }
	console.warn(`fail   ${composer.id}`); return false;
}
await mkdir(OUT_DIR, { recursive: true });
let ok = 0; for (const composer of COMPOSERS) if (await downloadOne(composer)) ok += 1;
console.log(`\nDownloaded ${ok}/${COMPOSERS.length} portraits into public/composers/`); if (ok === 0) process.exit(1);
