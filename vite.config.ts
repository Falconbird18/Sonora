import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const tauriPlatform = process.env.TAURI_ENV_PLATFORM;
const rootDir = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
	// Do NOT set base: './' for packaged Tauri apps.
	// Relative asset URLs can resolve incorrectly under the tauri.localhost
	// custom protocol, so the WebView receives index.html (text/html) for JS
	// modules and fails with a strict MIME-type error. Default base '/' emits
	// absolute /assets/... paths that match how Tauri serves frontendDist.
	plugins: [svelte()],
	clearScreen: false,
	resolve: {
		alias: {
			// Prevent Vite from externalizing Node's crypto (breaks @embedpdf in WebView).
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
