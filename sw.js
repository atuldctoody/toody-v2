// Service worker intentionally disabled.
// This file unregisters any previously installed SW and clears all caches.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', async () => {
  const keys = await caches.keys();
  await Promise.all(keys.map(k => caches.delete(k)));
  await self.registration.unregister();
  self.clients.claim();
});
