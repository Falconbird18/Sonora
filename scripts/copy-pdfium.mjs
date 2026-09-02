import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'node_modules/@embedpdf/pdfium/dist/pdfium.wasm');
const destination = resolve(root, 'src/lib/pdfium.wasm');

await mkdir(dirname(destination), { recursive: true });
await copyFile(source, destination);
console.log('Bundled PDFium WASM:', destination);
