const CACHE_STATIC = 'yt-static-v7';
const CACHE_VIDEO = 'yt-video-v1';

const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './app.js',
  './manifest.json',
  './icon-192.svg',
  './icon-512.svg'
];

// ── Install ─────────────────────────────────────────
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_STATIC).then(cache => cache.addAll(STATIC_ASSETS))
  );
  self.skipWaiting();
});

// ── Activate ────────────────────────────────────────
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys
        .filter(k => k !== CACHE_STATIC && k !== CACHE_VIDEO)
        .map(k => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

// ── Fetch ───────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== location.origin) return;

  // Streams de vídeo: servir desde cache del móvil si disponible
  if (url.pathname.startsWith('/api/stream/')) {
    event.respondWith(handleStreamRequest(event.request, url));
    return;
  }

  // No cachear /api/info, /api/download, /api/progress
  if (url.pathname.startsWith('/api/')) return;

  // Assets estáticos: cache-first
  event.respondWith(
    caches.match(event.request).then(cached => {
      const fetched = fetch(event.request).then(response => {
        const clone = response.clone();
        caches.open(CACHE_STATIC).then(cache => cache.put(event.request, clone));
        return response;
      }).catch(() => cached);
      return cached || fetched;
    })
  );
});

// ── Stream handler: cache-first con soporte Range ───
async function handleStreamRequest(request, url) {
  const cache = await caches.open(CACHE_VIDEO);
  // Clave canónica sin Range (el blob entero)
  const cacheKey = new Request(url.pathname, { method: 'GET' });
  const cached = await cache.match(cacheKey);

  if (cached) {
    // Servir desde cache local del móvil
    return serveFromCache(cached, request);
  }

  // No está en cache → pasar al servidor
  try {
    return await fetch(request);
  } catch {
    return new Response('Sin conexión y vídeo no cacheado', { status: 503 });
  }
}

// Servir un blob cacheado respondiendo a Range requests
async function serveFromCache(cachedResponse, originalRequest) {
  const blob = await cachedResponse.blob();
  const totalSize = blob.size;
  const contentType = cachedResponse.headers.get('Content-Type') || 'video/mp4';
  const range = originalRequest.headers.get('Range');

  if (range) {
    const m = range.match(/bytes=(\d+)-(\d*)/);
    if (m) {
      const start = parseInt(m[1], 10);
      const end = m[2] ? parseInt(m[2], 10) : totalSize - 1;
      const chunk = blob.slice(start, end + 1);
      return new Response(chunk, {
        status: 206,
        headers: {
          'Content-Type': contentType,
          'Content-Range': `bytes ${start}-${end}/${totalSize}`,
          'Content-Length': chunk.size,
          'Accept-Ranges': 'bytes'
        }
      });
    }
  }

  return new Response(blob, {
    status: 200,
    headers: {
      'Content-Type': contentType,
      'Content-Length': totalSize,
      'Accept-Ranges': 'bytes'
    }
  });
}

// ── Mensajes del cliente ────────────────────────────
self.addEventListener('message', (event) => {
  const msg = event.data;
  if (msg && msg.type === 'CACHE_VIDEO') {
    cacheVideoOnDevice(msg.videoId, msg.url);
  }
});

async function cacheVideoOnDevice(videoId, streamUrl) {
  try {
    const cache = await caches.open(CACHE_VIDEO);
    const cacheKey = new Request(`/api/stream/${videoId}`, { method: 'GET' });

    // ¿Ya cacheado en el móvil?
    const existing = await cache.match(cacheKey);
    if (existing) {
      notifyClients({ type: 'DEVICE_CACHE_PROGRESS', videoId, percent: 100 });
      return;
    }

    // Borrar vídeos anteriores del cache del móvil
    const keys = await cache.keys();
    for (const req of keys) {
      await cache.delete(req);
    }

    // Descargar el vídeo entero al móvil (sin Range header)
    notifyClients({ type: 'DEVICE_CACHE_PROGRESS', videoId, percent: 0 });

    const response = await fetch(streamUrl);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const contentLength = parseInt(response.headers.get('Content-Length') || '0');
    const contentType = response.headers.get('Content-Type') || 'video/mp4';

    if (!response.body) {
      // Fallback sin ReadableStream
      const blob = await response.blob();
      await cache.put(cacheKey, new Response(blob, {
        headers: { 'Content-Type': contentType, 'Content-Length': blob.size }
      }));
      notifyClients({ type: 'DEVICE_CACHE_PROGRESS', videoId, percent: 100 });
      return;
    }

    // Leer con progreso
    const reader = response.body.getReader();
    const chunks = [];
    let received = 0;
    let lastPct = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;

      if (contentLength > 0) {
        const pct = Math.floor((received / contentLength) * 100);
        if (pct >= lastPct + 2) {
          lastPct = pct;
          notifyClients({ type: 'DEVICE_CACHE_PROGRESS', videoId, percent: pct });
        }
      }
    }

    const blob = new Blob(chunks, { type: contentType });
    await cache.put(cacheKey, new Response(blob, {
      headers: { 'Content-Type': contentType, 'Content-Length': blob.size }
    }));

    notifyClients({ type: 'DEVICE_CACHE_PROGRESS', videoId, percent: 100 });
  } catch (e) {
    console.error('[SW] Error cacheando en dispositivo:', e);
    notifyClients({ type: 'DEVICE_CACHE_ERROR', videoId, error: e.message });
  }
}

async function notifyClients(msg) {
  const clients = await self.clients.matchAll({ type: 'window' });
  for (const client of clients) {
    client.postMessage(msg);
  }
}
