import { mkdir, copyFile, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(root, '..');

const src = path.join(
  projectRoot,
  'node_modules',
  '@embedpdf',
  'pdfium',
  'dist',
  'pdfium.wasm'
);
const destDir = path.join(projectRoot, 'public', 'pdfium');
const dest = path.join(destDir, 'pdfium.wasm');

try {
  await access(src);
} catch {
  console.warn('[copy-pdfium] Source WASM not found, skipping:', src);
  process.exit(0);
}

await mkdir(destDir, { recursive: true });
await copyFile(src, dest);
console.log('[copy-pdfium] Copied to', dest);
