/* Stock Tracker service worker.
 *
 * Deliberately hand-written and narrow in scope. The app is a SPA whose data
 * lives in IndexedDB and syncs through PocketBase, so the only thing worth
 * caching here is the app shell - enough to launch from the home screen
 * without a network, while never standing between the app and live data.
 *
 * Rules:
 *   - Same-origin GETs for build assets: cache-first, they are content-hashed.
 *   - Navigations: network-first, falling back to the cached shell offline.
 *     A SPA serves every route from index.html, so that fallback is the shell.
 *   - Everything else (prices, PocketBase, any cross-origin request): passed
 *     straight through. Caching a quote or a sync response would show stale
 *     money, which is worse than showing none.
 */

const VERSION = 'v1';
const SHELL_CACHE = `shell-${VERSION}`;
const ASSET_CACHE = `assets-${VERSION}`;

const SHELL_URLS = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.svg',
  '/pwa-192.png',
  '/pwa-512.png',
  '/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      // Individually, so one missing file cannot fail the whole install.
      .then((cache) => Promise.all(SHELL_URLS.map((u) => cache.add(u).catch(() => null))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((k) => k !== SHELL_CACHE && k !== ASSET_CACHE)
            .map((k) => caches.delete(k))
        )
      )
      .then(() => self.clients.claim())
  );
});

function isBuildAsset(url) {
  return url.pathname.startsWith('/assets/') || /\.(css|js|woff2?|png|svg|ico)$/i.test(url.pathname);
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  let url;
  try {
    url = new URL(request.url);
  } catch {
    return;
  }

  // Never touch other origins: the price backend, PocketBase, Google Fonts.
  if (url.origin !== self.location.origin) return;

  // Navigations: try the network so a deploy is picked up, fall back to shell.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((res) => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then((c) => c.put('/index.html', copy)).catch(() => {});
          return res;
        })
        .catch(() =>
          caches.match('/index.html').then((cached) => cached || caches.match('/'))
        )
    );
    return;
  }

  if (!isBuildAsset(url)) return;

  // Build assets are content-hashed, so a cache hit is always correct.
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request)
        .then((res) => {
          if (res && res.status === 200 && res.type === 'basic') {
            const copy = res.clone();
            caches.open(ASSET_CACHE).then((c) => c.put(request, copy)).catch(() => {});
          }
          return res;
        })
        .catch(() => cached);
    })
  );
});

// Lets the page trigger an immediate update rather than waiting for a restart.
self.addEventListener('message', (event) => {
  if (event.data === 'SKIP_WAITING') self.skipWaiting();
});
