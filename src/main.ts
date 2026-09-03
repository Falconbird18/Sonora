import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const target = document.getElementById('app');

if (!target) {
	throw new Error('Sonora mount target #app was not found');
}

// Never register a service worker inside the Tauri WebView. Stale workers from
// older builds intercept /assets/*.js and return HTML, which triggers the
// "Expected a JavaScript module but got text/html" white-screen failure.
if ('serviceWorker' in navigator) {
	void navigator.serviceWorker.getRegistrations().then((registrations) => {
		for (const registration of registrations) {
			void registration.unregister();
		}
	});
	if (typeof caches !== 'undefined') {
		void caches.keys().then((keys) => Promise.all(keys.map((key) => caches.delete(key))));
	}
}

// Clear the static HTML fallback before handing the root to Svelte.
target.replaceChildren();

mount(App, { target });
console.info('Sonora: Svelte app mounted');
