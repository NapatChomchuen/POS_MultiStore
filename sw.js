/** Minimal service worker — caches the app shell so the site installs as a
 *  PWA and opens instantly on repeat visits. It does NOT cache API calls to
 *  Google Apps Script, so order data is always fresh/live. */

// Bump this version string every time app.js/index.html/style.css change.
// Changing this file is what makes the browser notice there's an update at
// all — if sw.js itself is byte-identical to what's already installed, the
// browser never re-installs it and keeps serving the OLD cached app shell
// forever, no matter how many times you edit app.js on the server or hard-
// refresh the page.
const CACHE_NAME = 'pos-multistore-v7'; // bumped 2026-09-02: courier commission % (Settings sheet) + checkout customer capture
const APP_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) =>
      // { cache: 'reload' } forces a real network fetch for each file instead
      // of letting the browser's normal HTTP cache hand back a stale copy.
      Promise.all(APP_SHELL.map((url) =>
        fetch(url, { cache: 'reload' }).then((res) => cache.put(url, res))
      ))
    )
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // never cache calls to the Apps Script backend - always go to network
  if (url.hostname.includes('script.google.com')) return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
