import { mount } from 'svelte'
import './app.css'
import App from './App.svelte'

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch((error) => {
      console.warn('Sonora offline support could not be enabled:', error)
    })
  })
}

const app = mount(App, {
  target: document.getElementById('app')!,
})

export default app
