import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const target = document.getElementById('app');

if (!target) {
	throw new Error('Sonora mount target #app was not found');
}

// Keep startup synchronous and predictable. Vite/Svelte can load the app as a
// normal module, so there is no reason to add another dynamic-import stage.
// This also means a module-loading failure is reported by the browser directly
// instead of leaving Sonora in an artificial loading state.
mount(App, { target });
console.info('Sonora: Svelte app mounted');
