import { mount } from 'svelte';
import App from './App.svelte';
import './app.css';

const target = document.getElementById('app');

if (!target) {
	throw new Error('Sonora mount target #app was not found');
}

// Clear the static HTML fallback before handing the root to Svelte.
target.replaceChildren();

mount(App, { target });
console.info('Sonora: Svelte app mounted');
