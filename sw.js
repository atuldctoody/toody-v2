const CACHE = 'toody-v2-v11';
const APP_SHELL = [
  '/',
  '/index.html',
  '/app.html',
  '/styles.css',
  '/app.js',
  '/firebase-config.js',
  '/manifest.json',
  '/icons/toody-logo.png'
];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil((async () => {
    // Wipe ALL existing caches so no stale files survive the version bump
    const cacheNames = await caches.keys();
    await Promise.all(cacheNames.map(name => caches.delete(name)));
    // Re-populate with current version
    const cache = await caches.open(CACHE);
    await cache.addAll(APP_SHELL);
  })());
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Pass through Firebase, Google APIs, and the AI proxy — always network
  const url = e.request.url;
  if (
    url.includes('firebase') ||
    url.includes('googleapis') ||
    url.includes('gstatic') ||
    url.includes('toody-api') ||
    url.includes('firestore')
  ) return;

  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request).then(res => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(e.request, clone));
        return res;
      });
    })
  );
});
