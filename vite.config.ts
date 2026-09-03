import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const tauriPlatform = process.env.TAURI_ENV_PLATFORM;
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	plugins: [svelte()],
	clearScreen: false,
	resolve: {
		alias: {
			crypto: path.resolve(rootDir, 'src/lib/crypto-shim.ts')
		}
	},
	build: {
		target:
			tauriPlatform === 'windows'
				? 'chrome105'
				: tauriPlatform === 'darwin' || tauriPlatform === 'ios'
					? 'safari13'
					: undefined,
		commonjsOptions: {
			transformMixedEsModules: true
		}
	},
	server: {
		port: 5173,
		strictPort: true,
		watch: {
			ignored: ['**/src-tauri/**']
		}
	}
});
