// ── Service Worker (v4.85 — modular ES-module client) ───────────────────────
// CACHE_NAME must match APP_VERSION (js/app/config.js + version.json). Bump all
// three together on deploy so old caches purge on activation.
const CACHE_NAME = 'turndesk-v0.34';

const PRECACHE_URLS = [
  '/turndesk/',
  '/turndesk/index.html',
  '/turndesk/staff.html',
  '/turndesk/reports.html',
  '/turndesk/operator.html',
  '/turndesk/signup.html',
  '/turndesk/css/styles.css',
  '/turndesk/manifest.json',
  '/turndesk/manifest-staff.json',
  '/turndesk/manifest-reports.json',
  // App core
  '/turndesk/js/app/main.js',
  '/turndesk/js/app/staff.js',
  '/turndesk/js/app/reports-app.js',
  '/turndesk/js/app/store.js',
  '/turndesk/js/app/sync.js',
  '/turndesk/js/app/config.js',
  '/turndesk/js/app/modal-guard.js',
  '/turndesk/js/app/session.js',
  '/turndesk/js/app/utils.js',
  '/turndesk/js/app/reporter.js',
  '/turndesk/js/app/signup.js',
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
  '/turndesk/js/app/features/cashdrawer.js',
  '/turndesk/js/app/features/sms.js',
  '/turndesk/js/app/features/timeclock.js',
  '/turndesk/js/app/features/fd-schedule.js',
  '/turndesk/js/app/features/helcim.js',
  '/turndesk/js/app/features/quicksale.js',
  '/turndesk/js/app/features/search.js',
  '/turndesk/js/app/features/guide.js',
  '/turndesk/js/app/features/receipt.js',
  '/turndesk/js/app/features/review-qr.js',
  '/turndesk/js/app/features/diagnostics.js',
  // Assets
  '/turndesk/assets/muse-wordmark.png',
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
    // Only cache genuine successful same-origin responses — never a transient 404/500
    // (e.g. mid-deploy) or an opaque/redirected response, which would otherwise be
    // served from cache offline and leave a broken module stuck until the next online fetch.
    if (res && res.ok && res.type === 'basic' && !res.redirected) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(req, res.clone());
    }
    return res;
  } catch {
    const cached = await caches.match(req);
    if (cached) return cached;
    // Offline cache-miss: fall back to the app shell for navigations so the user lands
    // in the app instead of a raw browser network error.
    if (req.mode === 'navigate') {
      const shell = await caches.match('/turndesk/index.html');
      if (shell) return shell;
    }
    return Response.error();
  }
}

// ── Web Push (TurnDesk Staff) ────────────────────────────────────────────────────
// Payload-less pushes show the generic assignment text; encrypted payloads
// ({title, body, tag} — e.g. new-appointment alerts) override it. Distinct tags
// keep an appointment alert from replacing an unread assignment alert.
self.addEventListener('push', event => {
  let title = 'TurnDesk Staff', body = 'New customer assigned — tap to open', tag = 'turndesk-assign';
  try {
    if (event.data) {
      const d = event.data.json();
      if (d && d.title) title = d.title;
      if (d && d.body)  body  = d.body;
      if (d && d.tag)   tag   = d.tag;
    }
  } catch {}
  event.waitUntil(self.registration.showNotification(title, {
    body,
    icon: '/turndesk/icons/icon-192.png',
    badge: '/turndesk/icons/icon-192.png',
    tag,
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
