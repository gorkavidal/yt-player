// ═══════════════════════════════════════════════════════
// YT Player – Vídeo nativo con cache offline
//
// Usa yt-dlp en el servidor para obtener el stream MP4,
// <video> nativo para reproducir, y Service Worker para
// cachear el vídeo completo y reproducir sin conexión.
// ═══════════════════════════════════════════════════════

// ─── Estado ───
const state = {
  videoId: null,
  info: null,
  isPlaying: false,
  isSeeking: false,
  hasRetried: false,
  silentAudio: null,
  history: JSON.parse(localStorage.getItem('yt-history') || '[]'),
  timerEnd: null,
  timerInterval: null,
  positionInterval: null
};

// ─── DOM ───
const $ = sel => document.querySelector(sel);
const dom = {};

function initDOM() {
  dom.urlInput     = $('.url-input');
  dom.btnPaste     = $('.btn-paste');
  dom.btnPlay      = $('.btn-play');
  dom.statusText   = $('.status-text');
  dom.player       = $('.player-section');
  dom.video        = $('.player-video');
  dom.title        = $('.player-title');
  dom.author       = $('.player-author');
  dom.cacheStatus  = $('.cache-status');
  dom.progress     = $('.progress-bar');
  dom.timeCur      = $('.time-current');
  dom.timeDur      = $('.time-duration');
  dom.ctrlPrev     = $('.ctrl-prev');
  dom.ctrlBack     = $('.ctrl-back');
  dom.ctrlPlay     = $('.ctrl-play');
  dom.ctrlFwd      = $('.ctrl-fwd');
  dom.ctrlNext     = $('.ctrl-next');
  dom.ctrlFs       = $('.ctrl-fullscreen');
  dom.timerSection = $('.timer-section');
  dom.timerBtns    = $('.timer-buttons');
  dom.timerCountdown = $('.timer-countdown');
  dom.timerTime    = $('.timer-countdown-time');
  dom.timerOff     = $('.timer-off');
  dom.resume       = $('.resume-banner');
  dom.resumeText   = $('.resume-text');
  dom.btnResume    = $('.btn-resume');
  dom.btnRestart   = $('.btn-restart');
  dom.historyList  = $('.history-list');
  dom.installBanner = $('.install-banner');
  dom.closeBanner  = $('.close-banner');
}

// ─── Utilidades ───
function extractVideoId(url) {
  if (!url) return null;
  url = url.trim();
  let m;
  if ((m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/))) return m[1];
  if ((m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/)))      return m[1];
  if ((m = url.match(/embed\/([a-zA-Z0-9_-]{11})/)))      return m[1];
  if ((m = url.match(/shorts\/([a-zA-Z0-9_-]{11})/)))     return m[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  return null;
}

function escapeHtml(t) {
  const d = document.createElement('div');
  d.textContent = t;
  return d.innerHTML;
}

function formatTime(s) {
  if (!s || isNaN(s)) return '0:00';
  s = Math.floor(s);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function setStatus(text, type = '') {
  dom.statusText.textContent = text;
  dom.statusText.className = 'status-text' + (type ? ' ' + type : '');
}

function setButtonLoading(on) {
  dom.btnPlay.disabled = on;
  dom.btnPlay.innerHTML = on
    ? '<span class="spinner"></span> Cargando...'
    : 'Reproducir';
}

// ═══════════════════════════════════════════════════════
// AUDIO SILENCIOSO – Mantiene sesión activa en iOS
// ═══════════════════════════════════════════════════════

function generateSilentWav() {
  const rate = 8000, len = rate;
  const buf = new ArrayBuffer(44 + len);
  const v = new DataView(buf);
  const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + len, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate, true);
  v.setUint16(32, 1, true); v.setUint16(34, 8, true);
  w(36, 'data'); v.setUint32(40, len, true);
  for (let i = 44; i < 44 + len; i++) v.setUint8(i, 128);
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

function startSilentAudio() {
  if (state.silentAudio) return;
  const a = new Audio(generateSilentWav());
  a.loop = true;
  a.volume = 0.01;
  a.setAttribute('playsinline', '');
  a.play().catch(() => {});
  state.silentAudio = a;
}

function stopSilentAudio() {
  if (state.silentAudio) { state.silentAudio.pause(); state.silentAudio = null; }
}

// ═══════════════════════════════════════════════════════
// CACHE DE VÍDEO (comunicación con Service Worker)
// ═══════════════════════════════════════════════════════

// ── Cache en dos fases ──────────────────────────────
// Fase 1: servidor descarga con yt-dlp (polling /api/progress)
// Fase 2: SW descarga del servidor al cache del móvil
let downloadPollInterval = null;

// Polling no bloqueante: sigue el progreso del servidor y luego cachea en el móvil
function waitForServerThenCacheOnDevice(videoId) {
  stopDownloadPolling();
  downloadPollInterval = setInterval(async () => {
    try {
      const res = await fetch(`/api/progress/${videoId}`);
      const data = await res.json();

      if (data.status === 'ready') {
        stopDownloadPolling();
        startDeviceCache(videoId);
      } else if (data.status === 'downloading') {
        dom.cacheStatus.textContent = `Servidor: ${data.progress}%`;
      }
    } catch {
      stopDownloadPolling();
    }
  }, 1500);
}

function stopDownloadPolling() {
  if (downloadPollInterval) {
    clearInterval(downloadPollInterval);
    downloadPollInterval = null;
  }
}

async function startDeviceCache(videoId) {
  // Si ya hay una descarga en curso para otro vídeo, no la paramos
  // (se guarda su estado parcial automáticamente si sale)
  if (activeDownload && activeDownload.videoId !== videoId) {
    // El cambio de vídeo interrumpe la descarga anterior, pero el estado
    // parcial queda guardado en IndexedDB para reanudar después
    activeDownload.abortController.abort();
  }
  if (activeDownload && activeDownload.videoId === videoId) {
    return; // ya está descargando este
  }

  // Si ya está completo
  if (await isVideoCachedOnDevice(videoId)) {
    dom.cacheStatus.textContent = 'Guardado en móvil (offline)';
    dom.cacheStatus.classList.add('active', 'cached');
    return;
  }

  // ¿Hay una descarga parcial anterior?
  const partial = await getPartialDownload(videoId);
  const existingChunks = partial ? partial.chunks : [];
  let received = partial ? partial.receivedBytes : 0;
  let totalSize = partial ? partial.totalSize : 0;
  let contentType = partial ? partial.contentType : 'video/mp4';

  const abortController = new AbortController();
  activeDownload = { videoId, abortController };

  dom.cacheStatus.textContent = received > 0
    ? `Reanudando descarga... ${totalSize ? Math.floor((received/totalSize)*100) : 0}%`
    : 'Guardando en móvil...';
  dom.cacheStatus.classList.add('active');
  dom.cacheStatus.classList.remove('cached');

  // Guardado periódico del estado parcial (cada 3s)
  let lastSave = Date.now();
  const SAVE_INTERVAL = 3000;

  try {
    const headers = {};
    if (received > 0) headers['Range'] = `bytes=${received}-`;

    const response = await fetch(`/api/stream/${videoId}`, {
      signal: abortController.signal,
      headers
    });

    if (!response.ok && response.status !== 206) {
      throw new Error(`HTTP ${response.status}`);
    }

    // Leer tamaño total desde Content-Range o Content-Length
    const contentRange = response.headers.get('Content-Range');
    if (contentRange) {
      const m = contentRange.match(/\/(\d+)/);
      if (m) totalSize = parseInt(m[1], 10);
    } else {
      const len = parseInt(response.headers.get('Content-Length') || '0', 10);
      if (len > 0) totalSize = received + len;
    }
    contentType = response.headers.get('Content-Type') || contentType;

    if (!response.body) {
      const buffer = await response.arrayBuffer();
      existingChunks.push(buffer);
      await completeDownload(videoId, existingChunks, contentType);
      dom.cacheStatus.textContent = 'Guardado en móvil (offline)';
      dom.cacheStatus.classList.add('cached');
      renderHistory();
      if (activeDownload && activeDownload.videoId === videoId) activeDownload = null;
      return;
    }

    const reader = response.body.getReader();
    const chunks = [...existingChunks];
    let lastPct = -1;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      // Copiar a ArrayBuffer (IndexedDB no acepta Uint8Array con buffer compartido)
      const buf = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
      chunks.push(buf);
      received += value.byteLength;

      if (totalSize > 0) {
        const pct = Math.floor((received / totalSize) * 100);
        if (pct !== lastPct) {
          lastPct = pct;
          dom.cacheStatus.textContent = `Guardando en móvil... ${pct}%`;
        }
      }

      // Guardado periódico del progreso
      if (Date.now() - lastSave > SAVE_INTERVAL) {
        lastSave = Date.now();
        await savePartialDownload(videoId, chunks, received, totalSize, contentType);
      }
    }

    // Completado
    await completeDownload(videoId, chunks, contentType);
    dom.cacheStatus.textContent = 'Guardado en móvil (offline)';
    dom.cacheStatus.classList.add('cached');
    renderHistory();
  } catch (e) {
    if (e.name === 'AbortError') {
      // Descarga cancelada (usuario cambió de vídeo o cerró)
      // El estado parcial ya está guardado
      console.log('Descarga cancelada para', videoId);
    } else {
      console.error('Error cacheando en dispositivo:', e);
      // Guardar lo que tengamos antes de fallar
      // (ya se ha ido guardando cada 3s)
      dom.cacheStatus.textContent = 'Descarga interrumpida (reanudable)';
      setTimeout(() => dom.cacheStatus.classList.remove('active'), 3000);
    }
  } finally {
    if (activeDownload && activeDownload.videoId === videoId) {
      activeDownload = null;
    }
  }
}

// ═══════════════════════════════════════════════════════
// MSE PLAYER (ventana deslizante + cache por chunks)
// ═══════════════════════════════════════════════════════
// Reproduce vídeos grandes con MediaSource Extensions:
// - Carga chunks de 2 MB por byte-range
// - Mantiene 60 min buffered hacia adelante
// - Cachea cada chunk en IDB por separado (key: videoId_byteStart)
// - Si pierde red: reproduce desde chunks cacheados en IDB
// - Cuando vuelve red: continúa rellenando desde donde se quedó

const MSE_CHUNK_SIZE = 2 * 1024 * 1024;   // 2 MB por chunk
const MSE_PREFETCH_SECONDS = 60 * 60;     // 60 min adelante
const MSE_EVICT_BEHIND_SECONDS = 5 * 60;  // guardar últimos 5 min en sourceBuffer

const mse = {
  videoId: null,
  info: null,
  mediaSource: null,
  sourceBuffer: null,
  objectUrl: null,
  appendQueue: [],
  appending: false,
  maintainTimer: null,
  destroyed: false,
  loadingChunk: false
};

function supportsMse() {
  const MS = window.ManagedMediaSource || window.MediaSource;
  if (!MS) return false;
  // Verificar soporte de mime/codec
  return MS.isTypeSupported && MS.isTypeSupported('video/mp4; codecs="avc1.4d401f,mp4a.40.2"');
}

function destroyMsePlayer() {
  mse.destroyed = true;
  if (mse.maintainTimer) { clearTimeout(mse.maintainTimer); mse.maintainTimer = null; }
  const v = dom.video;
  v.removeEventListener('timeupdate', maintainBuffer);
  v.removeEventListener('seeking', maintainBuffer);
  v.removeEventListener('waiting', maintainBuffer);
  if (mse.mediaSource && mse.mediaSource.readyState === 'open') {
    try { mse.mediaSource.endOfStream(); } catch {}
  }
  if (mse.objectUrl) { URL.revokeObjectURL(mse.objectUrl); mse.objectUrl = null; }
  mse.mediaSource = null;
  mse.sourceBuffer = null;
  mse.appendQueue = [];
  mse.appending = false;
  mse.loadingChunk = false;
  mse.videoId = null;
}

async function startMsePlayback(videoId, info) {
  destroyMsePlayer();
  if (!info.size || !info.codecs || !info.codecs.combined) {
    throw new Error('Faltan size o codecs para MSE');
  }

  const MS = window.ManagedMediaSource || window.MediaSource;
  const ms = new MS();
  mse.mediaSource = ms;
  mse.videoId = videoId;
  mse.info = info;
  mse.destroyed = false;

  const url = URL.createObjectURL(ms);
  mse.objectUrl = url;
  dom.video.src = url;

  // Para ManagedMediaSource (iOS 17.1+), hay que setear disableRemotePlayback
  dom.video.disableRemotePlayback = true;

  await new Promise((resolve, reject) => {
    ms.addEventListener('sourceopen', resolve, { once: true });
    ms.addEventListener('error', () => reject(new Error('MediaSource error')), { once: true });
    setTimeout(() => reject(new Error('sourceopen timeout')), 10000);
  });
  if (mse.destroyed) return;

  const mime = `video/mp4; codecs="${info.codecs.combined}"`;
  if (!MS.isTypeSupported(mime)) {
    throw new Error(`Codec no soportado: ${mime}`);
  }

  const sb = ms.addSourceBuffer(mime);
  mse.sourceBuffer = sb;
  try { ms.duration = info.duration; } catch {}
  sb.addEventListener('updateend', processAppendQueue);
  sb.addEventListener('error', (e) => console.warn('sourceBuffer error', e));

  dom.video.addEventListener('timeupdate', maintainBuffer);
  dom.video.addEventListener('seeking', maintainBuffer);
  dom.video.addEventListener('waiting', maintainBuffer);

  // Arrancar mantenimiento
  maintainBuffer();
}

// ── Append queue (SourceBuffer solo procesa uno a la vez) ──
function enqueueAppend(data) {
  mse.appendQueue.push(data);
  processAppendQueue();
}

function processAppendQueue() {
  if (mse.destroyed) return;
  const sb = mse.sourceBuffer;
  if (!sb || sb.updating || mse.appendQueue.length === 0) return;
  const data = mse.appendQueue.shift();
  try {
    sb.appendBuffer(data);
  } catch (e) {
    if (e.name === 'QuotaExceededError') {
      // SourceBuffer lleno → evictar rangos antiguos
      evictSourceBufferBehind().then(() => {
        mse.appendQueue.unshift(data);
        processAppendQueue();
      });
    } else {
      console.error('appendBuffer fatal', e);
    }
  }
}

async function evictSourceBufferBehind() {
  const sb = mse.sourceBuffer;
  if (!sb || sb.updating) return;
  const ct = dom.video.currentTime;
  const cutoff = Math.max(0, ct - MSE_EVICT_BEHIND_SECONDS);
  if (sb.buffered.length > 0 && sb.buffered.start(0) < cutoff) {
    await new Promise((resolve) => {
      const onEnd = () => { sb.removeEventListener('updateend', onEnd); resolve(); };
      sb.addEventListener('updateend', onEnd);
      try { sb.remove(0, cutoff); } catch { resolve(); }
    });
  }
}

// ── Conversión tiempo ↔ byte ──
function msTimeToByte(t) {
  const { info } = mse;
  return Math.max(0, Math.min(info.size - 1, Math.floor((t / info.duration) * info.size)));
}
function msByteToTime(b) {
  const { info } = mse;
  return (b / info.size) * info.duration;
}

// ── Mantener buffer por delante ──
async function maintainBuffer() {
  if (mse.destroyed || mse.loadingChunk) return;
  const { info, sourceBuffer } = mse;
  if (!sourceBuffer) return;

  const ct = dom.video.currentTime || 0;
  const targetEnd = Math.min(info.duration, ct + MSE_PREFETCH_SECONDS);

  // Encontrar próximo tiempo que NO está buffered
  let t = ct;
  for (let i = 0; i < sourceBuffer.buffered.length; i++) {
    const s = sourceBuffer.buffered.start(i);
    const e = sourceBuffer.buffered.end(i);
    if (s <= t && t < e) t = e;
  }
  if (t >= targetEnd) {
    // Ya tenemos buffered hasta la ventana. Esperar que avance currentTime.
    mse.maintainTimer = setTimeout(maintainBuffer, 3000);
    return;
  }
  if (t >= info.duration - 0.5) return;  // fin del vídeo

  const byteStart = msTimeToByte(t);
  // Alinear byteStart a múltiplo de CHUNK_SIZE para máxima cache-hit
  const alignedStart = Math.floor(byteStart / MSE_CHUNK_SIZE) * MSE_CHUNK_SIZE;
  const byteEnd = Math.min(alignedStart + MSE_CHUNK_SIZE - 1, info.size - 1);

  mse.loadingChunk = true;
  try {
    const data = await loadChunk(alignedStart, byteEnd);
    if (mse.destroyed || !data) return;
    enqueueAppend(data);
    mse.maintainTimer = setTimeout(maintainBuffer, 50);
  } catch (e) {
    console.warn(`Chunk load failed: ${e.message}. Retry in 5s.`);
    setStatus(`Sin conexión. Reintentando...`, '');
    mse.maintainTimer = setTimeout(maintainBuffer, 5000);
  } finally {
    mse.loadingChunk = false;
  }
}

// ── Load chunk: IDB cache-first, luego fetch ──
async function loadChunk(byteStart, byteEnd) {
  const videoId = mse.videoId;
  const cached = await idbGet(CHUNKS_STORE, `${videoId}_${byteStart}`);
  if (cached && cached.data) return cached.data;

  const resp = await fetch(`/api/stream/${videoId}`, {
    headers: { 'Range': `bytes=${byteStart}-${byteEnd}` }
  });
  if (!resp.ok && resp.status !== 206) throw new Error(`HTTP ${resp.status}`);
  const data = await resp.arrayBuffer();

  // Guardar en IDB (fire-and-forget para no bloquear playback)
  saveChunkToIdb(videoId, byteStart, byteEnd, data).catch(() => {});
  return data;
}

async function saveChunkToIdb(videoId, byteStart, byteEnd, data) {
  const record = {
    id: `${videoId}_${byteStart}`,
    videoId, byteStart, byteEnd, data,
    date: Date.now()
  };
  try {
    await idbPut(CHUNKS_STORE, record);
  } catch (e) {
    // Cuota llena → evictar chunks viejos y reintentar
    await evictOldChunks(videoId);
    try { await idbPut(CHUNKS_STORE, record); } catch {}
  }
}

// Borrar chunks más antiguos de otros vídeos (o del mismo si es muy viejo)
async function evictOldChunks(currentVideoId) {
  const all = await idbGetAll(CHUNKS_STORE);
  if (all.length === 0) return;
  // Prioridad: primero chunks de otros vídeos, ordenados por fecha (más viejos)
  all.sort((a, b) => {
    const aOther = a.videoId !== currentVideoId ? 0 : 1;
    const bOther = b.videoId !== currentVideoId ? 0 : 1;
    if (aOther !== bOther) return aOther - bOther;
    return (a.date || 0) - (b.date || 0);
  });
  // Borrar los primeros 10 (o hasta 100 MB)
  let freed = 0;
  for (let i = 0; i < Math.min(10, all.length); i++) {
    await idbDelete(CHUNKS_STORE, all[i].id);
    freed += all[i].data.byteLength || 0;
    if (freed > 100 * 1024 * 1024) break;
  }
}

// Borrar todos los chunks de un vídeo (al quitarlo del historial)
async function deleteMseChunksForVideo(videoId) {
  const all = await idbGetAll(CHUNKS_STORE);
  for (const rec of all) {
    if (rec.videoId === videoId) await idbDelete(CHUNKS_STORE, rec.id);
  }
}

// ═══════════════════════════════════════════════════════
// REPRODUCTOR DE VÍDEO
// ═══════════════════════════════════════════════════════

function setupVideoEvents() {
  const v = dom.video;

  v.addEventListener('play', () => {
    state.isPlaying = true;
    updatePlayBtn();
    startSilentAudio();
    startPositionSaving();
    updateMediaSessionState('playing');
    dom.timerSection.classList.add('active');
  });

  v.addEventListener('pause', () => {
    state.isPlaying = false;
    updatePlayBtn();
    savePosition();
    updateMediaSessionState('paused');
  });

  v.addEventListener('timeupdate', () => {
    if (!state.isSeeking) updateProgress();
  });

  v.addEventListener('loadedmetadata', () => {
    if (v.duration && isFinite(v.duration)) {
      dom.timeDur.textContent = formatTime(v.duration);
      dom.progress.max = v.duration;
    }
  });

  v.addEventListener('durationchange', () => {
    if (v.duration && isFinite(v.duration)) {
      dom.timeDur.textContent = formatTime(v.duration);
      dom.progress.max = v.duration;
    }
  });

  v.addEventListener('ended', () => {
    state.isPlaying = false;
    updatePlayBtn();
    clearSavedPosition(state.videoId);
    stopPositionSaving();
    playNextFromHistory();
  });

  v.addEventListener('error', async () => {
    const err = v.error;
    const code = err ? err.code : '?';
    const msg = err ? err.message : 'desconocido';
    console.error('Video error:', code, msg, v.src);

    if (!state.hasRetried && state.videoId) {
      state.hasRetried = true;
      setStatus(`Reintentando... (error ${code})`, '');
      try {
        await fetch(`/api/info/${state.videoId}?refresh=1`);
        v.src = `/api/stream/${state.videoId}`;
        v.load();
        await v.play();
        return;
      } catch {}
    }
    setStatus(`Error: ${msg} (código ${code})`, 'error');
    setButtonLoading(false);
  });

  v.addEventListener('waiting', () => setStatus('Cargando...'));
  v.addEventListener('playing', () => {
    if (state.info) setStatus(state.info.title, 'success');
  });
}

function updatePlayBtn() {
  dom.ctrlPlay.textContent = state.isPlaying ? '⏸' : '▶';
}

function updateProgress() {
  const v = dom.video;
  if (!v || !v.duration || !isFinite(v.duration)) return;
  dom.progress.value = v.currentTime;
  dom.timeCur.textContent = formatTime(v.currentTime);
  const pct = (v.currentTime / v.duration) * 100;
  dom.progress.style.setProperty('--fill', `${pct}%`);
}

function togglePlayPause() {
  const v = dom.video;
  if (!v || !v.src) return;
  if (state.isPlaying) {
    v.pause();
  } else {
    startSilentAudio();
    v.play().catch(() => {});
  }
}

function seekRelative(delta) {
  const v = dom.video;
  if (!v || !v.duration) return;
  v.currentTime = Math.max(0, Math.min(v.duration, v.currentTime + delta));
}

function toggleFullscreen() {
  const v = dom.video;
  if (!v) return;
  // iOS Safari usa webkitEnterFullscreen en el <video>
  if (v.webkitEnterFullscreen) {
    v.webkitEnterFullscreen();
  } else if (v.requestFullscreen) {
    v.requestFullscreen();
  } else if (v.webkitRequestFullscreen) {
    v.webkitRequestFullscreen();
  }
}

// ═══════════════════════════════════════════════════════
// INDEXEDDB VIDEO CACHE (con descargas reanudables)
// ═══════════════════════════════════════════════════════
// Dos object stores:
//   - videos: { id, data (ArrayBuffer), date, contentType } - vídeos completos
//   - downloads: { id, chunks (Array<ArrayBuffer>), receivedBytes,
//                  totalSize, contentType, date } - descargas en progreso

const DB_NAME = 'yt-video-cache';
const DB_VERSION = 3;
const VIDEOS_STORE = 'videos';
const DOWNLOADS_STORE = 'downloads';
const CHUNKS_STORE = 'mse_chunks';  // chunks por byte-range para reproducción MSE

// Controlador de descarga actual (para poder cancelar)
let activeDownload = null; // { videoId, abortController }

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (event) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(VIDEOS_STORE)) {
        db.createObjectStore(VIDEOS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(DOWNLOADS_STORE)) {
        db.createObjectStore(DOWNLOADS_STORE, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(CHUNKS_STORE)) {
        const store = db.createObjectStore(CHUNKS_STORE, { keyPath: 'id' });
        store.createIndex('videoId', 'videoId', { unique: false });
        store.createIndex('date', 'date', { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet(storeName, key) {
  return openDB().then(db => new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => resolve(null);
  })).catch(() => null);
}

function idbPut(storeName, value) {
  return openDB().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  }));
}

function idbDelete(storeName, key) {
  return openDB().then(db => new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readwrite');
    tx.objectStore(storeName).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => resolve();
  })).catch(() => {});
}

function idbCount(storeName, key) {
  return openDB().then(db => new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).count(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => resolve(0);
  })).catch(() => 0);
}

function idbGetAll(storeName) {
  return openDB().then(db => new Promise((resolve) => {
    const tx = db.transaction(storeName, 'readonly');
    const req = tx.objectStore(storeName).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => resolve([]);
  })).catch(() => []);
}

async function isVideoCachedOnDevice(videoId) {
  const count = await idbCount(VIDEOS_STORE, videoId);
  return count > 0;
}

async function getCachedBlobUrl(videoId) {
  const record = await idbGet(VIDEOS_STORE, videoId);
  if (!record) return null;
  // Nuevo formato: { chunks: [ArrayBuffer, ...] }
  // Viejo formato (retrocompat): { data: ArrayBuffer }
  const parts = record.chunks && record.chunks.length ? record.chunks
               : record.data ? [record.data] : null;
  if (!parts) return null;
  // Blob constructor con array de ArrayBuffers NO copia, solo referencia
  const blob = new Blob(parts, { type: record.contentType || 'video/mp4' });
  return URL.createObjectURL(blob);
}

async function getPartialDownload(videoId) {
  return idbGet(DOWNLOADS_STORE, videoId);
}

async function savePartialDownload(videoId, chunks, receivedBytes, totalSize, contentType) {
  try {
    await idbPut(DOWNLOADS_STORE, {
      id: videoId,
      chunks,
      receivedBytes,
      totalSize,
      contentType: contentType || 'video/mp4',
      date: Date.now()
    });
  } catch (e) {
    // Sin espacio — intentar desalojar el más viejo y reintentar
    await evictOldest(videoId);
    try { await idbPut(DOWNLOADS_STORE, {
      id: videoId, chunks, receivedBytes, totalSize,
      contentType: contentType || 'video/mp4', date: Date.now()
    }); } catch {}
  }
}

async function completeDownload(videoId, chunks, contentType) {
  // Guardamos los chunks como array en IndexedDB — sin concatenar en buffer
  // contiguo. Un Uint8Array de 1 GB+ revienta por OOM en iOS Safari.
  // El Blob constructor con array de ArrayBuffers no copia internamente.
  const save = () => idbPut(VIDEOS_STORE, {
    id: videoId,
    chunks: chunks,
    contentType: contentType || 'video/mp4',
    date: Date.now()
  });

  try {
    await save();
  } catch {
    await evictOldest(videoId);
    await save();
  }

  // Borrar el parcial
  await idbDelete(DOWNLOADS_STORE, videoId);
}

async function evictOldest(excludeId) {
  // Prioridad: borrar antes parciales abandonados que vídeos completos
  const partials = await idbGetAll(DOWNLOADS_STORE);
  const old = partials
    .filter(p => p.id !== excludeId && Date.now() - (p.date || 0) > 24 * 3600000);
  for (const p of old) {
    await idbDelete(DOWNLOADS_STORE, p.id);
    return;
  }

  const videos = await idbGetAll(VIDEOS_STORE);
  videos.sort((a, b) => (a.date || 0) - (b.date || 0));
  for (const v of videos) {
    if (v.id === excludeId) continue;
    await idbDelete(VIDEOS_STORE, v.id);
    return;
  }
}

async function deleteCachedVideo(videoId) {
  await idbDelete(VIDEOS_STORE, videoId);
  await idbDelete(DOWNLOADS_STORE, videoId);
  renderHistory();
}

async function deleteCachedVideo(videoId) {
  await deleteCachedVideoFromDB(videoId);
  renderHistory();
}

// ═══════════════════════════════════════════════════════
// REPRODUCCIÓN
// ═══════════════════════════════════════════════════════

async function playVideo(videoId, startTime) {
  setButtonLoading(true);
  setStatus('Obteniendo vídeo...');
  state.videoId = videoId;
  state.hasRetried = false;
  dom.resume.classList.remove('active');
  dom.cacheStatus.classList.remove('active', 'cached');

  // Comprobar posición guardada
  const saved = getSavedPosition(videoId);
  if (startTime === undefined && saved && saved.time > 5) {
    showResumeBanner(videoId, saved.time);
    setButtonLoading(false);
    return;
  }

  startSilentAudio();

  try {
    // Intentar obtener info del servidor, pero si estamos offline
    // usar los datos del historial local
    let info = null;
    const cachedOnDevice = await isVideoCachedOnDevice(videoId);

    try {
      const res = await fetch(`/api/info/${videoId}`);
      if (res.ok) info = await res.json();
    } catch {}

    if (!info) {
      // Offline — buscar en historial local
      const histEntry = state.history.find(h => h.id === videoId);
      if (histEntry && cachedOnDevice) {
        info = {
          title: histEntry.title,
          author: histEntry.author,
          duration: 0,
          thumb: histEntry.thumb,
          cached: true
        };
      } else {
        throw new Error('Sin conexión y vídeo no disponible');
      }
    }

    state.info = info;

    // Mostrar player
    dom.player.classList.add('active');
    dom.title.textContent = info.title;
    dom.author.textContent = info.author;
    if (info.duration) dom.timeDur.textContent = formatTime(info.duration);
    dom.progress.max = info.duration || 100;
    dom.progress.value = startTime || 0;
    dom.timeCur.textContent = formatTime(startTime || 0);
    dom.progress.style.setProperty('--fill', '0%');

    const v = dom.video;
    v.poster = info.thumb;

    if (!info.cached && !cachedOnDevice) {
      // Pedir descarga al servidor en background
      fetch(`/api/download/${videoId}`).catch(() => {});
    }

    // ── Estrategia de reproducción ─────────────────
    // Preferido: MSE (ventana deslizante + cache por chunks en IDB)
    //   → requiere: MSE soportado + info.codecs del servidor + fMP4 en servidor
    // Fallback 1: blob URL completo (si estaba ya cacheado entero en IDB por el flujo viejo)
    // Fallback 2: /api/stream/ directo (streaming simple vía servidor)
    const canUseMse = supportsMse() && info.cached && info.size && info.codecs && info.codecs.combined;
    let usingMse = false;

    if (canUseMse) {
      try {
        await startMsePlayback(videoId, info);
        usingMse = true;
      } catch (e) {
        console.warn('MSE falló, fallback a blob/stream:', e.message);
        destroyMsePlayer();
      }
    }

    if (!usingMse) {
      // Destruir cualquier MSE residual
      destroyMsePlayer();
      if (cachedOnDevice) {
        const blobUrl = await getCachedBlobUrl(videoId);
        v.src = blobUrl || `/api/stream/${videoId}`;
      } else {
        v.src = `/api/stream/${videoId}`;
      }
    }
    setStatus('Cargando vídeo...');

    if (startTime && startTime > 0) {
      await new Promise(r => {
        const handler = () => { v.currentTime = startTime; r(); };
        if (v.readyState >= 1) handler();
        else v.addEventListener('loadedmetadata', handler, { once: true });
        setTimeout(r, 8000);
      });
    }

    // play() en contexto de gesto — iOS lo permite
    v.play().catch(() => {});

    // ── Estado de cache ──
    if (usingMse) {
      dom.cacheStatus.textContent = 'Cache adaptativo (60 min adelante)';
      dom.cacheStatus.classList.add('active', 'cached');
    } else if (cachedOnDevice) {
      dom.cacheStatus.textContent = 'Guardado en móvil (offline)';
      dom.cacheStatus.classList.add('active', 'cached');
    } else if (!info.cached) {
      dom.cacheStatus.textContent = 'Servidor descargando...';
      dom.cacheStatus.classList.add('active');
      waitForServerThenCacheOnDevice(videoId);
    } else {
      // En servidor pero no en móvil, cachear vía flujo viejo (blob completo)
      dom.cacheStatus.classList.add('active');
      startDeviceCache(videoId);
    }

    setupMediaSession(info);
    addToHistory(videoId, info.title, info.author);
  } catch (err) {
    console.error('Error:', err);
    setStatus(err.message || 'Error al cargar', 'error');
  }

  setButtonLoading(false);
}

// ═══════════════════════════════════════════════════════
// GUARDADO DE POSICIÓN
// ═══════════════════════════════════════════════════════

function savePosition(ended) {
  const v = dom.video;
  if (!v || !state.videoId) return;
  try {
    const time = ended ? 0 : v.currentTime;
    const duration = v.duration;
    if (!duration || !isFinite(duration)) return;
    if (!ended && (time < 5 || time > duration - 5)) return;
    localStorage.setItem(`yt-pos-${state.videoId}`, JSON.stringify({
      time: Math.floor(time),
      duration: Math.floor(duration),
      date: Date.now()
    }));
  } catch {}
}

function getSavedPosition(videoId) {
  try {
    const raw = localStorage.getItem(`yt-pos-${videoId}`);
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (Date.now() - data.date > 30 * 24 * 3600000) return null;
    return data;
  } catch { return null; }
}

function clearSavedPosition(videoId) {
  localStorage.removeItem(`yt-pos-${videoId}`);
}

function startPositionSaving() {
  stopPositionSaving();
  state.positionInterval = setInterval(() => savePosition(), 15000);
}

function stopPositionSaving() {
  if (state.positionInterval) {
    clearInterval(state.positionInterval);
    state.positionInterval = null;
  }
}

function showResumeBanner(videoId, time) {
  dom.resumeText.textContent = `Continuar desde ${formatTime(time)}`;
  dom.resume.classList.add('active');
  dom.btnResume.onclick = () => {
    dom.resume.classList.remove('active');
    playVideo(videoId, time);
  };
  dom.btnRestart.onclick = () => {
    dom.resume.classList.remove('active');
    clearSavedPosition(videoId);
    playVideo(videoId, 0);
  };
}

// ═══════════════════════════════════════════════════════
// TEMPORIZADOR
// ═══════════════════════════════════════════════════════

function startTimer(minutes) {
  clearTimer();
  if (minutes <= 0) return;

  state.timerEnd = Date.now() + minutes * 60000;
  dom.timerBtns.querySelectorAll('.timer-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.timer) === minutes);
  });
  dom.timerOff.classList.remove('active');
  dom.timerCountdown.classList.add('active');
  updateTimerDisplay();

  state.timerInterval = setInterval(() => {
    const remaining = state.timerEnd - Date.now();
    if (remaining <= 0) { timerExpired(); return; }
    updateTimerDisplay();
  }, 1000);
}

function updateTimerDisplay() {
  if (!state.timerEnd) return;
  const rem = Math.max(0, state.timerEnd - Date.now());
  const m = Math.floor(rem / 60000);
  const s = Math.floor((rem % 60000) / 1000);
  dom.timerTime.textContent = `${m}:${String(s).padStart(2, '0')}`;
}

function timerExpired() {
  savePosition();
  dom.video.pause();
  clearTimer();
  setStatus('Temporizador: reproducción pausada', 'success');
}

function clearTimer() {
  if (state.timerInterval) { clearInterval(state.timerInterval); state.timerInterval = null; }
  state.timerEnd = null;
  dom.timerCountdown.classList.remove('active');
  dom.timerBtns.querySelectorAll('.timer-btn').forEach(btn => btn.classList.remove('active'));
  dom.timerOff.classList.add('active');
}

// ═══════════════════════════════════════════════════════
// MEDIA SESSION
// ═══════════════════════════════════════════════════════

function setupMediaSession(info) {
  if (!('mediaSession' in navigator)) return;

  navigator.mediaSession.metadata = new MediaMetadata({
    title: info.title,
    artist: info.author,
    artwork: [
      { src: info.thumb, sizes: '480x360', type: 'image/jpeg' },
      { src: `https://i.ytimg.com/vi/${state.videoId}/maxresdefault.jpg`, sizes: '1280x720', type: 'image/jpeg' }
    ]
  });

  navigator.mediaSession.setActionHandler('play', () => {
    startSilentAudio();
    dom.video.play().catch(() => {});
  });
  navigator.mediaSession.setActionHandler('pause', () => dom.video.pause());
  navigator.mediaSession.setActionHandler('seekbackward', () => seekRelative(-15));
  navigator.mediaSession.setActionHandler('seekforward', () => seekRelative(15));
  navigator.mediaSession.setActionHandler('previoustrack', () => playPrevFromHistory());
  navigator.mediaSession.setActionHandler('nexttrack', () => playNextFromHistory());
}

function updateMediaSessionState(s) {
  if ('mediaSession' in navigator) navigator.mediaSession.playbackState = s;
}

// ═══════════════════════════════════════════════════════
// HISTORIAL
// ═══════════════════════════════════════════════════════

function addToHistory(videoId, title, author) {
  state.history = state.history.filter(h => h.id !== videoId);
  state.history.unshift({ id: videoId, title, author,
    thumb: `https://i.ytimg.com/vi/${videoId}/default.jpg` });
  if (state.history.length > 30) state.history.pop();
  localStorage.setItem('yt-history', JSON.stringify(state.history));
  renderHistory();
}

async function removeFromHistory(videoId) {
  // Si hay una descarga activa para este vídeo, abortarla
  if (activeDownload && activeDownload.videoId === videoId) {
    activeDownload.abortController.abort();
    activeDownload = null;
  }

  state.history = state.history.filter(h => h.id !== videoId);
  clearSavedPosition(videoId);
  localStorage.setItem('yt-history', JSON.stringify(state.history));

  // Borrar también del cache (completo, parcial y chunks MSE) para no dejar rémoras
  await idbDelete(VIDEOS_STORE, videoId);
  await idbDelete(DOWNLOADS_STORE, videoId);
  await deleteMseChunksForVideo(videoId);

  renderHistory();
}

async function renderHistory() {
  if (state.history.length === 0) {
    dom.historyList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎵</div>
        <p>Pega un enlace de YouTube<br>para empezar</p>
      </div>`;
    return;
  }

  // Comprobar estado de cache (completo / parcial) de cada vídeo
  const cacheChecks = await Promise.all(state.history.map(async h => {
    const cached = await isVideoCachedOnDevice(h.id);
    if (cached) return { complete: true };
    const partial = await getPartialDownload(h.id);
    if (partial && partial.totalSize > 0) {
      return {
        partial: true,
        pct: Math.floor((partial.receivedBytes / partial.totalSize) * 100)
      };
    }
    return {};
  }));

  dom.historyList.innerHTML = state.history.map((h, i) => {
    const saved = getSavedPosition(h.id);
    const posBadge = saved && saved.time > 5
      ? `<span class="history-badge">${formatTime(saved.time)}</span>` : '';
    const state = cacheChecks[i];
    let cacheBadge = '';
    if (state.complete) {
      cacheBadge = `<span class="cache-badge" data-uncache="${h.id}">offline ✕</span>`;
    } else if (state.partial) {
      cacheBadge = `<span class="cache-badge partial" data-uncache="${h.id}">${state.pct}% ✕</span>`;
    }
    return `
      <div class="history-item" data-id="${h.id}">
        <img class="history-thumb" src="${h.thumb}" alt="" loading="lazy">
        <div class="history-info">
          <div class="history-info-title">${escapeHtml(h.title)}</div>
          <div class="history-info-author">${escapeHtml(h.author)}${posBadge}${cacheBadge}</div>
        </div>
        <button class="history-delete" data-delete="${h.id}" aria-label="Eliminar">✕</button>
      </div>`;
  }).join('');
}

function playNextFromHistory() {
  if (state.history.length < 2) return;
  const idx = state.history.findIndex(h => h.id === state.videoId);
  playVideo(state.history[(idx + 1) % state.history.length].id);
}

function playPrevFromHistory() {
  if (state.history.length < 2) return;
  const idx = state.history.findIndex(h => h.id === state.videoId);
  playVideo(state.history[(idx - 1 + state.history.length) % state.history.length].id);
}

// ─── Clipboard ───
async function pasteFromClipboard() {
  try {
    const text = await navigator.clipboard.readText();
    dom.urlInput.value = text;
    handlePlayRequest();
  } catch {
    dom.urlInput.focus();
    setStatus('Pega el enlace manualmente (mantén pulsado)', '');
  }
}

function handlePlayRequest() {
  const url = dom.urlInput.value.trim();
  if (!url) { setStatus('Introduce un enlace de YouTube', 'error'); return; }
  const videoId = extractVideoId(url);
  if (!videoId) { setStatus('Enlace de YouTube no válido', 'error'); return; }
  playVideo(videoId);
}

function checkInstallBanner() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  const dismissed = localStorage.getItem('install-dismissed');
  if (!isStandalone && !dismissed) dom.installBanner.style.display = 'block';
}

function setupVisibilityHandler() {
  document.addEventListener('visibilitychange', () => { if (document.hidden) savePosition(); });
  window.addEventListener('beforeunload', () => savePosition());
}

// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════

function init() {
  initDOM();
  setupVideoEvents();

  dom.btnPaste.addEventListener('click', pasteFromClipboard);
  dom.btnPlay.addEventListener('click', handlePlayRequest);
  dom.urlInput.addEventListener('keydown', e => { if (e.key === 'Enter') handlePlayRequest(); });

  dom.urlInput.addEventListener('focus', async () => {
    if (dom.urlInput.value === '') {
      try {
        const text = await navigator.clipboard.readText();
        if (extractVideoId(text)) dom.urlInput.value = text;
      } catch {}
    }
  });

  // Controles
  dom.ctrlPlay.addEventListener('click', togglePlayPause);
  dom.ctrlBack.addEventListener('click', () => seekRelative(-15));
  dom.ctrlFwd.addEventListener('click', () => seekRelative(15));
  dom.ctrlPrev.addEventListener('click', () => playPrevFromHistory());
  dom.ctrlNext.addEventListener('click', () => playNextFromHistory());
  dom.ctrlFs.addEventListener('click', toggleFullscreen);

  // Progress bar
  dom.progress.addEventListener('input', () => {
    state.isSeeking = true;
    dom.timeCur.textContent = formatTime(dom.progress.value);
    const pct = (dom.progress.value / dom.progress.max) * 100;
    dom.progress.style.setProperty('--fill', `${pct}%`);
  });
  dom.progress.addEventListener('change', () => {
    dom.video.currentTime = parseFloat(dom.progress.value);
    state.isSeeking = false;
  });

  // Timer
  dom.timerBtns.addEventListener('click', e => {
    const btn = e.target.closest('[data-timer]');
    if (!btn) return;
    const mins = parseInt(btn.dataset.timer);
    if (mins === 0) clearTimer(); else startTimer(mins);
  });

  // Historial
  dom.historyList.addEventListener('click', e => {
    const uncache = e.target.closest('[data-uncache]');
    if (uncache) { e.stopPropagation(); deleteCachedVideo(uncache.dataset.uncache); return; }
    const del = e.target.closest('[data-delete]');
    if (del) { e.stopPropagation(); removeFromHistory(del.dataset.delete); return; }
    const item = e.target.closest('.history-item');
    if (item) playVideo(item.dataset.id);
  });

  // Banner
  dom.closeBanner.addEventListener('click', () => {
    dom.installBanner.style.display = 'none';
    localStorage.setItem('install-dismissed', '1');
  });

  // Service Worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.warn);
  }

  renderHistory();
  checkInstallBanner();
  setupVisibilityHandler();
}

document.addEventListener('DOMContentLoaded', init);
