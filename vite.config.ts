import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin, type ViteDevServer } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const tauriPlatform = process.env.TAURI_ENV_PLATFORM;
const rootDir = path.dirname(fileURLToPath(import.meta.url));

// A browser can request a cached component's virtual stylesheet before its JS
// after a dev-server restart. Populate Svelte's CSS metadata before its loader runs.
function svelteDevStyles(): Plugin {
	let server: ViteDevServer;
	return {
		name: 'sonora:svelte-dev-styles',
		apply: 'serve',
		enforce: 'pre',
		configureServer(value) {
			server = value;
		},
		async load(id) {
			if (this.environment.config.consumer !== 'client') return;
			const [filename, query] = id.split('?', 2);
			if (!filename.endsWith('.svelte') || !query) return;
			const params = new URLSearchParams(query);
			if (params.has('svelte') && params.get('type') === 'style') {
				await server.environments.client.transformRequest(filename);
			}
		}
	};
}

export default defineConfig({
	plugins: [svelteDevStyles(), svelte()],
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
