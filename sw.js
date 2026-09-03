/** Minimal service worker — caches the app shell so the site installs as a
 *  PWA and opens instantly on repeat visits. It does NOT cache API calls to
 *  Google Apps Script, so order data is always fresh/live. */

// Bump this version string every time app.js/index.html/style.css change.
// Changing this file is what makes the browser notice there's an update at
// all — if sw.js itself is byte-identical to what's already installed, the
// browser never re-installs it and keeps serving the OLD cached app shell
// forever, no matter how many times you edit app.js on the server or hard-
// refresh the page.
//
// Bump it as well after running tools/optimize-images.py, since the product
// photos below are part of the cached shell now.
const CACHE_NAME = 'pos-multistore-v8'; // bumped 2026-09-04: one-call bootstrap, request timeouts, optimized images

// Files the app cannot work without — if any of these fail to cache, this
// version of the service worker is broken and must not install.
const CORE_SHELL = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// Product and store photos, from images/opt/ (built by tools/optimize-images.py
// — see optimizedImageUrl in app.js for why the app reads the optimized copies
// rather than the originals the Google Sheet points at).
//
// These were previously not cached at all: the fetch handler below looked them
// up in the cache, always missed, and fell through to the network. Combined
// with GitHub Pages' 10-minute max-age that meant a phone re-downloaded the
// whole product grid several times a day. The optimized set is ~250 KB total,
// so caching all of it up front costs less than a single original photo did.
const IMAGE_SHELL = [
  './images/opt/stores/water-store-logo.jpg',
  './images/opt/products/AmmaritSet1.jpg',
  './images/opt/products/AmmaritSet2.jpg',
  './images/opt/products/Ammarit 300ml.jpg',
  './images/opt/products/Ammarit 600ml.jpg',
  './images/opt/products/Ammarit 1500ml.jpg',
  './images/opt/products/Crystal 600ml.jpg',
  './images/opt/products/Crystal 1500ml.jpg',
  './images/opt/products/Singha 600ml.jpg',
  './images/opt/products/Singha 1500ml.jpg',
  './images/opt/products/L_Naba.jpg',
  './images/opt/products/ข้าวสวย.jpg',
];

// { cache: 'reload' } forces a real network fetch for each file instead of
// letting the browser's normal HTTP cache hand back a stale copy.
async function cacheFresh(cache, url) {
  const res = await fetch(url, { cache: 'reload' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  await cache.put(url, res);
}

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await Promise.all(CORE_SHELL.map((url) => cacheFresh(cache, url)));
    // Photos are best-effort on purpose: a product image that was renamed in the
    // sheet, or not yet regenerated, must not abort the whole install — a failed
    // install would leave the old app shell in place AND break the auto-update
    // path in app.js. A missing photo just falls back to the network instead.
    const results = await Promise.allSettled(IMAGE_SHELL.map((url) => cacheFresh(cache, url)));
    results
      .filter((r) => r.status === 'rejected')
      .forEach((r) => console.warn('SW: image not cached —', r.reason && r.reason.message));
  })());
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

  // Never cache calls to the Apps Script backend - always go to network.
  // Note both hostnames: an /exec request to script.google.com is answered with
  // a redirect to script.googleusercontent.com, and "script.googleusercontent.com"
  // does NOT contain the substring "script.google.com", so checking only the
  // first one would have let the redirected response through this handler.
  if (url.hostname === 'script.google.com' || url.hostname === 'script.googleusercontent.com') return;

  event.respondWith(
    caches.match(event.request).then((cached) => cached || fetch(event.request))
  );
});
