/**
 * Service worker: makes the app open instantly and work with no signal.
 *
 * Strategy:
 *   - App shell + timetable: cache-first, refreshed in the background.
 *     Opening the app on the subway must still show the correct schedule.
 *   - Passio API calls: never cached here (app.js handles its own fallback).
 */
const VERSION = 'stuyshuttle-v14';
const SHELL = [
  './',
  './index.html',
  './css/app.css',
  './js/app.js',
  './js/api.js',
  './js/schedule.js',
  './js/store.js',
  './js/ics.js',
  './js/push.js',
  './js/text.js',
  './js/timetable.js',
  './js/live.js',
  './js/ui.js',
  './js/views/trip.js',
  './js/views/alerts.js',
  './js/views/routes.js',
  './js/views/settings.js',
  './data/timetable.json',
  './data/walk.json',
  './data/seed-times.json',
  './icons/icon-180.png',
  './icons/icon-192.png',
  './manifest.webmanifest',
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(VERSION)
      // cache: 'reload' skips the HTTP cache so a new deploy's files are
      // fetched fresh (GitHub Pages serves everything with max-age=600).
      .then((c) => c.addAll(SHELL.map((u) => new Request(u, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);

  // Never intercept the transit API -- staleness there is dangerous, and
  // app.js already has an explicit fallback chain.
  if (url.hostname.endsWith('passiogo.com')) return;
  if (e.request.method !== 'GET') return;

  // Never cache the service worker script itself. Doing so pins the app to an
  // old worker: the browser fetches sw.js to check for updates, gets the stale
  // cached copy back, and concludes nothing changed -- so version bumps never
  // take effect and the shell stays frozen.
  if (url.pathname.endsWith('/sw.js')) return;

  e.respondWith(
    caches.match(e.request).then((hit) => {
      // Serve cache immediately, then quietly refresh it for next time.
      const net = fetch(e.request)
        .then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((c) => c.put(e.request, copy));
          }
          return res;
        })
        .catch(() => hit);
      return hit || net;
    })
  );
});

/* ---- push notifications (payload sent by worker/) ---- */
self.addEventListener('push', (e) => {
  let d = { title: 'StuyShuttle', body: 'Shuttle update.' };
  try {
    let parsed = e.data.json();
    // Tolerate a doubly-encoded payload rather than showing a raw JSON blob.
    if (typeof parsed === 'string') parsed = JSON.parse(parsed);
    if (parsed && typeof parsed === 'object') d = { ...d, ...parsed };
  } catch { /* keep default */ }
  e.waitUntil(
    self.registration.showNotification(d.title, {
      body: d.body,
      icon: './icons/icon-192.png',
      badge: './icons/icon-192.png',
      tag: d.tag || 'departure',
      renotify: true,
      requireInteraction: false,
      data: { url: d.url || './index.html#alerts' },
    })
  );
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const target = e.notification.data?.url || './index.html';
  e.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) { c.navigate?.(target).catch?.(() => {}); return c.focus(); }
      }
      return clients.openWindow(target);
    })
  );
});
