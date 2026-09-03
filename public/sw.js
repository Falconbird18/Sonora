/* Sonora desktop builds must not use a service worker.
 * Older builds may still have one registered under tauri.localhost;
 * this file unregisters itself and clears caches so asset loads work again.
 */
self.addEventListener('install', (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      const regs = await self.registration.unregister();
      const clients = await self.clients.matchAll({ type: 'window' });
      for (const client of clients) {
        client.navigate(client.url);
      }
      return regs;
    })()
  );
});

self.addEventListener('fetch', (event) => {
  // Never intercept — always hit the network / Tauri custom protocol.
  return;
});
