import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const target = document.getElementById('app');

if (!target) {
	throw new Error('Sonora mount target #app was not found');
}

const isTauri =
	typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

// Service workers are for browser/PWA only. In the Tauri WebView they can
// intercept /assets/*.js and return HTML, which white-screens the app.
if ('serviceWorker' in navigator) {
	if (isTauri) {
		void navigator.serviceWorker.getRegistrations().then((registrations) => {
			for (const registration of registrations) {
				void registration.unregister();
			}
		});
		if (typeof caches !== 'undefined') {
			void caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))));
		}
	} else if (import.meta.env.PROD) {
		window.addEventListener('load', () => {
			navigator.serviceWorker.register('./sw.js').catch((error) => {
				console.warn('Sonora offline support could not be enabled:', error);
			});
		});
	}
}

target.replaceChildren();
mount(App, { target });
console.info('Sonora: Svelte app mounted');
