import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';

const tauriPlatform = process.env.TAURI_ENV_PLATFORM;

export default defineConfig({
	// Relative asset paths are required for the packaged Tauri WebView.
	// Absolute `/assets/...` URLs resolve incorrectly under the custom
	// protocol and produce a blank/white window in production builds.
	base: './',
	plugins: [svelte()],
	clearScreen: false,
	build: {
		// Tauri's production WebView can differ from the browser used for normal
		// Vite development. Keep the generated JavaScript within the WebView
		// compatibility target recommended by Tauri for each desktop platform.
		target:
			tauriPlatform === 'windows'
				? 'chrome105'
				: tauriPlatform === 'darwin' || tauriPlatform === 'ios'
					? 'safari13'
					: undefined
	},
	server: {
		port: 5173,
		strictPort: true,
		watch: {
			ignored: ['**/src-tauri/**']
		}
	}
});
