/* ═══════════════════════════════════════════════════════════════════════════
   sw.js — Bluff PWA Service Worker
   Strategy:
     • Static shell (HTML, manifest, icons) → Cache-first w/ background revalidate
     • All other same-origin requests        → Network-first, cache as fallback
     • Socket.io / WebSocket traffic         → BYPASSED entirely (never cached)
   ═══════════════════════════════════════════════════════════════════════════ */

'use strict';

/* ── Cache identifiers ─────────────────────────────────────────────────────
   Bump CACHE_NAME whenever the app shell changes so stale caches are evicted.
   ──────────────────────────────────────────────────────────────────────── */
const CACHE_NAME    = 'bluff-v1';
const SHELL_ASSETS  = [
  'index.html',
  'manifest.json',
  'icon-192.png',
  'icon-512.png',
];

/* ── Patterns that must NEVER be intercepted by the SW ────────────────────
   Socket.io uses HTTP long-polling as a transport before upgrading to WS,
   so the URL contains "/socket.io/" even for HTTP requests. We must let
   those flow straight to the network.
   ──────────────────────────────────────────────────────────────────────── */
const BYPASS_PATTERNS = [
  /\/socket\.io\//,           // Socket.io HTTP polling & upgrade endpoint
  /\/sockjs-node\//,          // Common dev-server WS path
];

/* ─────────────────────────────────────────────────────────────────────────
   INSTALL — pre-cache the app shell
   ───────────────────────────────────────────────────────────────────────── */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      console.log('[SW] Pre-caching app shell…');
      return cache.addAll(SHELL_ASSETS);
    }).then(() => {
      // Skip the waiting phase so the new SW activates immediately
      // instead of waiting for all existing tabs to close.
      return self.skipWaiting();
    })
  );
});

/* ─────────────────────────────────────────────────────────────────────────
   ACTIVATE — remove caches from prior versions
   ───────────────────────────────────────────────────────────────────────── */
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)  // every cache that isn't current
          .map((key) => {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          })
      );
    }).then(() => {
      // Claim all open clients immediately so they use the new SW
      // without requiring a page refresh.
      return self.clients.claim();
    })
  );
});

/* ─────────────────────────────────────────────────────────────────────────
   FETCH — routing logic
   ───────────────────────────────────────────────────────────────────────── */
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url         = new URL(request.url);

  /* 1. Ignore non-GET requests (POST, PUT, DELETE …).
        These are never cached — let them fall through to the network. */
  if (request.method !== 'GET') return;

  /* 2. Ignore non-HTTP(S) schemes (chrome-extension://, data:, blob:, etc.) */
  if (!url.protocol.startsWith('http')) return;

  /* 3. BYPASS: Socket.io / WebSocket traffic.
        Even for HTTP polling requests, if the path matches a real-time
        pattern we MUST NOT intercept — return immediately so the browser
        handles it natively. */
  if (BYPASS_PATTERNS.some((pattern) => pattern.test(url.pathname))) {
    return; // Do nothing → browser sends request normally
  }

  /* 4. App-shell assets → CACHE-FIRST with background revalidation (SWR).
        These files are small and change rarely; we serve them instantly
        from cache while quietly refreshing the cached copy for next time. */
  const isShellAsset = SHELL_ASSETS.some((asset) => url.pathname.endsWith(asset));
  if (isShellAsset || url.pathname === '/' || url.pathname.endsWith('/')) {
    event.respondWith(staleWhileRevalidate(request));
    return;
  }

  /* 5. Everything else (fonts, analytics, CDN resources, etc.) → NETWORK-FIRST.
        Try the network; on failure serve whatever we have cached.
        If nothing is cached either, serve a generic offline fallback. */
  event.respondWith(networkFirstWithCacheFallback(request));
});

/* ═══════════════════════════════════════════════════════════════════════════
   STRATEGY HELPERS
   ═══════════════════════════════════════════════════════════════════════════ */

/**
 * Stale-While-Revalidate
 * Serves from cache immediately (fastest possible load) while fetching a
 * fresh copy in the background to update the cache for the next request.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function staleWhileRevalidate(request) {
  const cache    = await caches.open(CACHE_NAME);
  const cached   = await cache.match(request);

  // Kick off a background refresh regardless of whether we have a cache hit
  const fetchPromise = fetch(request).then((networkResponse) => {
    if (networkResponse && networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;
  }).catch(() => {
    /* Network unavailable — the cached copy (if any) already returned */
  });

  // Return cached immediately if available; otherwise await the network
  return cached || fetchPromise;
}

/**
 * Network-First with Cache Fallback
 * Tries the network; on any failure serves the cached version.
 * If no cache exists either, returns a minimal offline response.
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function networkFirstWithCacheFallback(request) {
  const cache = await caches.open(CACHE_NAME);

  try {
    const networkResponse = await fetch(request);

    // Cache successful, cacheable responses
    if (networkResponse && networkResponse.ok) {
      cache.put(request, networkResponse.clone());
    }
    return networkResponse;

  } catch (_err) {
    // Network failed — try cache
    const cached = await cache.match(request);
    if (cached) return cached;

    // Nothing in cache — return a minimal offline indicator.
    // The app's UI handles the "offline" state via socket disconnect events.
    return new Response(
      JSON.stringify({ offline: true, message: 'No network connection.' }),
      {
        status:  503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}
