// ── Service Worker (v2.72 — modular ES-module client) ───────────────────────
// CACHE_NAME must match APP_VERSION (js/app/config.js + version.json). Bump all
// three together on deploy so old caches purge on activation.
const CACHE_NAME = 'turndesk-v3.67';

const PRECACHE_URLS = [
  '/turndesk/',
  '/turndesk/index.html',
  '/turndesk/staff.html',
  '/turndesk/css/styles.css',
  '/turndesk/manifest.json',
  '/turndesk/manifest-staff.json',
  // App core
  '/turndesk/js/app/main.js',
  '/turndesk/js/app/staff.js',
  '/turndesk/js/app/store.js',
  '/turndesk/js/app/sync.js',
  '/turndesk/js/app/config.js',
  '/turndesk/js/app/session.js',
  '/turndesk/js/app/utils.js',
  // Feature modules
  '/turndesk/js/app/features/auth.js',
  '/turndesk/js/app/features/photos.js',
  '/turndesk/js/app/features/catalog.js',
  '/turndesk/js/app/features/square-customers.js',
  '/turndesk/js/app/features/square-catalog.js',
  '/turndesk/js/app/features/square-pos.js',
  '/turndesk/js/app/features/staff.js',
  '/turndesk/js/app/features/checkin.js',
  '/turndesk/js/app/features/status.js',
  '/turndesk/js/app/features/queue.js',
  '/turndesk/js/app/features/turns.js',
  '/turndesk/js/app/features/reports.js',
  '/turndesk/js/app/features/giftcards.js',
  '/turndesk/js/app/features/settings.js',
  '/turndesk/js/app/features/calendar.js',
  '/turndesk/js/app/features/floorplan.js',
  '/turndesk/js/app/features/appearance.js',
  '/turndesk/js/app/features/servicetime.js',
  '/turndesk/js/app/features/chat.js',
  '/turndesk/js/app/features/appt-reminders.js',
  '/turndesk/js/app/features/recovery.js',
  '/turndesk/js/app/features/audit.js',
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      // Use individual puts so one missing file doesn't fail the whole install.
      .then(cache => Promise.all(PRECACHE_URLS.map(u => cache.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;            // proxies/CDN → network
  if (!url.pathname.startsWith('/turndesk/')) return;
  if (req.cache === 'no-store' || req.cache === 'no-cache') return;

  // Network-first for EVERYTHING same-origin (shell, JS modules, CSS, assets):
  // when online, always serve the freshly-deployed files so a version bump applies
  // on a single reload (no stale cached modules); fall back to cache only when
  // offline. Keeps the PWA offline-capable without ever serving stale code.
  event.respondWith(networkFirst(req));
});

async function networkFirst(req) {
  try {
    const res = await fetch(req);
    const cache = await caches.open(CACHE_NAME);
    cache.put(req, res.clone());
    return res;
  } catch { return caches.match(req); }
}

// ── Web Push (TurnDesk Staff) ────────────────────────────────────────────────────
// Payload-less pushes: show a generic notification; the tech taps to open the app.
self.addEventListener('push', event => {
  let body = 'New customer assigned — tap to open';
  try { if (event.data) { const d = event.data.json(); if (d && d.body) body = d.body; } } catch {}
  event.waitUntil(self.registration.showNotification('TurnDesk Staff', {
    body,
    icon: '/turndesk/icons/icon-192.png',
    badge: '/turndesk/icons/icon-192.png',
    tag: 'turndesk-assign',
    renotify: true,
  }));
});
self.addEventListener('notificationclick', event => {
  event.notification.close();
  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then(list => {
      for (const c of list) { if (c.url.includes('/turndesk/staff') && 'focus' in c) return c.focus(); }
      return clients.openWindow('/turndesk/staff.html');
    })
  );
});
