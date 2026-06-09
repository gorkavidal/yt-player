const STATIC_CACHE = 'yt-static-v23';
const HLS_CACHE = 'yt-hls-v1';
const INFO_CACHE = 'yt-info-v1';

const ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(STATIC_CACHE).then(cache => cache.addAll(ASSETS)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    const keep = new Set([STATIC_CACHE, HLS_CACHE, INFO_CACHE]);
    await Promise.all(
      keys
        .filter(key => key.startsWith('yt-') && !keep.has(key))
        .map(key => caches.delete(key))
    );
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  if (url.pathname.startsWith('/api/hls/')) {
    event.respondWith(handleHls(event.request, url));
    return;
  }

  // /api/info/:id → stale-while-revalidate (devuelve cache al instante,
  // refresca en background). Permite arrancar sin servidor disponible.
  if (url.pathname.startsWith('/api/info/')) {
    event.respondWith(handleInfo(event.request));
    return;
  }

  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(handleStatic(event.request));
});

async function handleInfo(request) {
  const cache = await caches.open(INFO_CACHE);
  const cached = await cache.match(request);

  // Lanzar refresh en background siempre (no esperar)
  const refresh = fetch(request).then(async (response) => {
    if (response && response.ok) {
      await cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  }).catch(() => null);

  // Si hay cache, devolverlo inmediatamente
  if (cached) return cached;

  // Sin cache: esperar al fetch (con fallback 503 si falla)
  const fresh = await refresh;
  if (fresh) return fresh;
  return new Response(JSON.stringify({ error: 'offline' }), {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}

async function handleStatic(request) {
  const cached = await caches.match(request);
  const fetched = fetch(request).then(async (response) => {
    if (response && response.ok) {
      const cache = await caches.open(STATIC_CACHE);
      cache.put(request, response.clone()).catch(() => {});
    }
    return response;
  }).catch(() => cached);
  return cached || fetched;
}

async function handleHls(request, url) {
  const cache = await caches.open(HLS_CACHE);

  if (url.pathname.endsWith('.m3u8')) {
    try {
      const response = await fetch(request);
      if (response.ok) await cache.put(request, response.clone());
      return response;
    } catch {
      const cached = await cache.match(request);
      return cached || new Response('HLS playlist unavailable', { status: 503 });
    }
  }

  const cached = await cache.match(request);
  if (cached) return cached;

  const response = await fetch(request);
  if (response.ok) {
    await cache.put(request, response.clone()).catch(() => {});
  }
  return response;
}
