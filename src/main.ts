const target = document.getElementById('app')

type StartupTarget = HTMLElement | null

function escapeHtml(value: unknown) {
  return String(value).replace(/[&<>]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[char] ?? char))
}

function setStatus(message: string, detail = '') {
  const root = target as StartupTarget
  if (!root) return
  root.innerHTML = `
    <main style="box-sizing:border-box;min-height:100%;display:grid;place-items:center;padding:32px;background:#11110f;color:#f5f5f4;font-family:system-ui,sans-serif">
      <section style="width:min(760px,100%);padding:28px;border:1px solid #3a3a35;border-radius:16px;background:#191914;box-shadow:0 18px 50px rgba(0,0,0,.28)">
        <h1 style="margin:0 0 10px;font-size:24px">Starting Sonora…</h1>
        <p style="margin:0 0 12px;color:#c8c8c1;line-height:1.5">${escapeHtml(message)}</p>
        ${detail ? `<pre style="margin:0;padding:14px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;border-radius:10px;background:#10100d;color:#deded7;font:13px/1.5 ui-monospace,SFMono-Regular,Consolas,monospace">${escapeHtml(detail)}</pre>` : ''}
      </section>
    </main>
  `
}

function showStartupError(reason: unknown) {
  const message = reason instanceof Error ? `${reason.name}: ${reason.message}` : String(reason)
  console.error('Sonora failed to start', reason)
  if (!target) return
  setStatus('Sonora could not start', message)
}

if (!target) {
  throw new Error('Sonora mount target #app was not found')
}

setStatus('Frontend JavaScript loaded.', 'Stage 1/4: main.ts is executing.')

const runtime = globalThis as typeof globalThis & { __TAURI_INTERNALS__?: unknown }
const isDesktop = !!runtime.__TAURI_INTERNALS__
setStatus('Frontend JavaScript loaded.', `Stage 2/4: runtime detected (${isDesktop ? 'Tauri desktop' : 'browser'}).`)

if ('serviceWorker' in navigator && import.meta.env.PROD && !isDesktop) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch((error) => {
      console.warn('Sonora offline support could not be enabled:', error)
    })
  })
}

setStatus('Loading Sonora interface…', 'Stage 3/4: importing App.svelte.')

void import('./App.svelte')
  .then(({ default: App }) => {
    setStatus('Mounting Sonora interface…', 'Stage 4/4: App.svelte imported successfully.')
    try {
      return import('svelte').then(({ mount }) => {
        // The static HTML contains a startup fallback. Svelte mounts into the
        // target rather than treating arbitrary existing children as a template,
        // so remove that fallback before handing control to Svelte.
        target.replaceChildren()
        mount(App, { target })
        console.info('Sonora: Svelte app mounted')
      })
    } catch (reason) {
      showStartupError(reason)
    }
  })
  .catch(showStartupError)
