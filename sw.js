// SH PLANNER service worker: offline app shell, versioned cache.
const CACHE = 'shp-2026-10-11-v111';
const SHELL = ['./', 'index.html', 'css/app.css', 'js/app.js', 'js/logic.js', 'js/db.js', 'js/notify.js', 'js/images.js', 'js/account.js', 'js/syncmerge.js', 'js/firebase-config.js', 'js/cloud.js', 'js/vendor/capacitor.js',
  'manifest.webmanifest', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/maskable-192.png', 'icons/maskable-512.png', 'icons/favicon-32.png', 'icons/apple-touch-icon.png', 'icons/badge-96.png'];
self.addEventListener('install', (e) => { e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener('activate', (e) => { e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener('fetch', (e) => {
  const req = e.request; if (req.method !== 'GET') return;
  const url = new URL(req.url); if (url.origin !== location.origin) return;
  if (url.pathname.endsWith('.apk')) return;
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((r) => { const cp = r.clone(); caches.open(CACHE).then((c) => c.put('index.html', cp)); return r; }).catch(() => caches.match('index.html')));
    return;
  }
  // stale-while-revalidate for app files
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((r) => { if (r.ok) { const cp = r.clone(); caches.open(CACHE).then((c) => c.put(req, cp)); } return r; }).catch(() => hit);
    return hit || net;
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const data = e.notification.data || {};
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((cs) => {
    for (const c of cs) { c.postMessage({ type: 'open', data }); return c.focus(); }
    return self.clients.openWindow(data.date ? './#/plan/day/' + data.date : './');
  }));
});
