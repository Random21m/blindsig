// blindsig service worker: caches the app shell so it opens offline.
// Mint API calls are never cached. Fonts are served from this site, so no third party sees app loads.
const VERSION = 'mwzrxf1p';
const SHELL = ['./', './index.html', './app.js', './manifest.webmanifest', './fonts/fonts.css', './icons/icon.svg', './icons/icon-192.png', './icons/apple-touch-icon.png'];

self.addEventListener('install', (e) => {
  // cache: 'reload' skips the browser's HTTP cache, so a new version never stores an older app.js
  // (GitHub Pages lets browsers keep files for 10 minutes, and updates can come faster than that)
  e.waitUntil(caches.open('shell-' + VERSION).then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' })))).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== 'shell-' + VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin !== self.location.origin) return; // mints: straight to network

  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).catch(() => caches.match('./index.html')));
    return;
  }
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => hit || fetch(req).then((r) => {
    if (r.ok && /\/(i18n|fonts)\//.test(url.pathname)) { const copy = r.clone(); caches.open('shell-' + VERSION).then((c) => c.put(req, copy)); }
    return r;
  })));
});
