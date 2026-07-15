/* NFL2026 service worker — PURE CACHE-PURGER.
 *
 * WHY this exists but caches NOTHING (mirrors the wc2026 approach):
 *   The app ships unhashed filenames and controls freshness entirely via HTTP
 *   headers (see _headers: short max-age + stale-while-revalidate). A caching
 *   service worker on top of that caused the exact bug we refuse to reintroduce
 *   on wc2026: users ran up-to-a-day-old JS after a deploy because the SW served
 *   a stale shell. So this SW deliberately installs NO fetch handler — every
 *   request goes straight to the network — and on activate it DELETES every
 *   cache this app ever created, so any install that previously cached files
 *   stops serving them on its next visit.
 *
 * It stays REGISTERED (reversible): if real offline support is wanted later,
 * add precache + a fetch handler here. Today it is a purger and nothing else.
 */
const VERSION = 'nfl26-v1';

self.addEventListener('install', () => {
  // No precache. Activate immediately so the no-cache behaviour applies on the
  // next navigation instead of waiting for every tab to close.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    // Purge every cache this app ever created — nothing is served offline.
    const names = await caches.keys();
    await Promise.all(
      names.filter((n) => n.startsWith('nfl26-')).map((n) => caches.delete(n))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('message', (event) => {
  // Lightweight version probe so the client can confirm which SW is active.
  if (event.data && event.data.type === 'GET_VERSION') {
    event.ports?.[0]?.postMessage({ type: 'VERSION', version: VERSION });
  }
});

// NOTE: intentionally NO 'fetch' handler. Without one the service worker does
// not control any request, so all fetches hit the network directly. That is
// precisely what keeps the app from ever serving stale, cached code.
