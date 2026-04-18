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

function startDeviceCache(videoId) {
  if (!navigator.serviceWorker || !navigator.serviceWorker.controller) {
    dom.cacheStatus.textContent = 'Listo (sin cache offline)';
    return;
  }
  dom.cacheStatus.textContent = 'Guardando en móvil...';
  navigator.serviceWorker.controller.postMessage({
    type: 'CACHE_VIDEO',
    videoId: videoId,
    url: `/api/stream/${videoId}`
  });
}

function setupSwMessages() {
  if (!navigator.serviceWorker) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const msg = event.data;
    if (msg.type === 'DEVICE_CACHE_PROGRESS') {
      if (msg.percent >= 100) {
        dom.cacheStatus.textContent = 'Guardado en móvil (offline)';
        dom.cacheStatus.classList.add('cached');
        renderHistory(); // actualizar badge offline en historial
      } else {
        dom.cacheStatus.textContent = `Guardando en móvil... ${msg.percent}%`;
      }
    } else if (msg.type === 'DEVICE_CACHE_EVICTED') {
      renderHistory(); // actualizar badges
    } else if (msg.type === 'DEVICE_CACHE_ERROR') {
      dom.cacheStatus.textContent = 'Error al guardar en móvil';
      setTimeout(() => dom.cacheStatus.classList.remove('active'), 3000);
    }
  });
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
// GESTIÓN DE CACHE (consultar/borrar vídeos individuales)
// ═══════════════════════════════════════════════════════

async function isVideoCachedOnDevice(videoId) {
  if (!('caches' in window)) return false;
  try {
    const cache = await caches.open('yt-video-v1');
    const match = await cache.match(`/api/stream/${videoId}`);
    return !!match;
  } catch { return false; }
}

async function deleteCachedVideo(videoId) {
  if (!('caches' in window)) return;
  try {
    const cache = await caches.open('yt-video-v1');
    await cache.delete(`/api/stream/${videoId}`);
  } catch {}
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
    const res = await fetch(`/api/info/${videoId}`);
    if (!res.ok) {
      const e = await res.json().catch(() => ({}));
      throw new Error(e.error || `Error ${res.status}`);
    }
    const info = await res.json();
    state.info = info;

    // Mostrar player
    dom.player.classList.add('active');
    dom.title.textContent = info.title;
    dom.author.textContent = info.author;
    dom.timeDur.textContent = formatTime(info.duration);
    dom.progress.max = info.duration || 100;
    dom.progress.value = startTime || 0;
    dom.timeCur.textContent = formatTime(startTime || 0);
    dom.progress.style.setProperty('--fill', '0%');

    const v = dom.video;
    v.poster = info.thumb;

    if (!info.cached) {
      // Pedir descarga al servidor en background
      fetch(`/api/download/${videoId}`).catch(() => {});
    }

    // Poner src inmediatamente (el servidor espera si aún está descargando)
    // Esto mantiene la cadena de gesto de usuario para que iOS permita play()
    v.src = `/api/stream/${videoId}`;
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

    // Mostrar progreso del servidor si aún está descargando
    if (!info.cached) {
      dom.cacheStatus.textContent = 'Servidor descargando...';
      dom.cacheStatus.classList.add('active');
      waitForServerThenCacheOnDevice(videoId);
    } else {
      // Ya en servidor, cachear en móvil directamente
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

function removeFromHistory(videoId) {
  state.history = state.history.filter(h => h.id !== videoId);
  clearSavedPosition(videoId);
  localStorage.setItem('yt-history', JSON.stringify(state.history));
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

  // Comprobar qué vídeos están cacheados en el dispositivo
  const cacheChecks = await Promise.all(
    state.history.map(h => isVideoCachedOnDevice(h.id))
  );

  dom.historyList.innerHTML = state.history.map((h, i) => {
    const saved = getSavedPosition(h.id);
    const posBadge = saved && saved.time > 5
      ? `<span class="history-badge">${formatTime(saved.time)}</span>` : '';
    const cached = cacheChecks[i];
    const cacheBadge = cached
      ? `<span class="cache-badge" data-uncache="${h.id}">offline ✕</span>` : '';
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
  setupSwMessages();

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
