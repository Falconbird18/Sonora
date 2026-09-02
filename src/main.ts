import { mount } from 'svelte'
import './app.css'
import './lib/scoreViewerPolish.css'
import { isTauri } from './lib/paths'

const target = document.getElementById('app')

function showStartupError(reason: unknown) {
  const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
  console.error('Sonora failed to start', reason)
  if (!target) return
  target.innerHTML = `
    <main style="box-sizing:border-box;min-height:100%;display:grid;place-items:center;padding:32px;background:#11110f;color:#f5f5f4;font-family:system-ui,sans-serif">
      <section style="width:min(760px,100%);padding:28px;border:1px solid #3a3a35;border-radius:16px;background:#191914;box-shadow:0 18px 50px rgba(0,0,0,.28)">
        <h1 style="margin:0 0 10px;font-size:24px">Sonora could not start</h1>
        <p style="margin:0 0 18px;color:#c8c8c1;line-height:1.5">A component failed while the desktop application was loading.</p>
        <pre style="margin:0;padding:14px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:10px;background:#10100d;color:#deded7;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace">${message.replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char] ?? char))}</pre>
      </section>
    </main>
  `
}

if (!target) {
  throw new Error('Sonora mount target #app was not found')
}

if ('serviceWorker' in navigator && import.meta.env.PROD && !isTauri()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('Sonora offline support could not be enabled:', error)
    })
  })
}

const appPromise = import('./App.svelte')
  .then(({ default: App }) => mount(App, { target }))
  .catch((reason) => {
    showStartupError(reason)
    throw reason
  })

export default appPromise
