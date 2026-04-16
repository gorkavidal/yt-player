// ═══════════════════════════════════════════════════════
// YT Player – YouTube embebido en PWA
//
// - Embed estándar de YouTube (IFrame Player API)
// - Audio silencioso nativo para mantener sesión de audio
//   activa en PWA standalone (iOS no suspende el WebView)
// - Temporizador de apagado (sleep timer)
// - Guardado automático de posición de reproducción
// ═══════════════════════════════════════════════════════

// ─── Estado ───
const state = {
  videoId: null,
  player: null,
  playerReady: false,
  silentAudio: null,     // <audio> silencioso para mantener sesión iOS
  history: JSON.parse(localStorage.getItem('yt-history') || '[]'),
  // Timer
  timerMinutes: 0,
  timerEnd: null,        // timestamp de fin
  timerInterval: null,
  // Posición
  positionInterval: null
};

// ─── DOM ───
const $ = (sel) => document.querySelector(sel);
const dom = {};

function initDOM() {
  dom.urlInput = $('.url-input');
  dom.btnPaste = $('.btn-paste');
  dom.btnPlay = $('.btn-play');
  dom.statusText = $('.status-text');
  dom.playerSection = $('.player-section');
  dom.playerWrap = $('.player-wrap');
  dom.historyList = $('.history-list');
  dom.installBanner = $('.install-banner');
  dom.closeBanner = $('.close-banner');
  // Timer
  dom.timerSection = $('.timer-section');
  dom.timerButtons = $('.timer-buttons');
  dom.timerCountdown = $('.timer-countdown');
  dom.timerCountdownTime = $('.timer-countdown-time');
  dom.timerOff = $('.timer-off');
  // Resume
  dom.resumeBanner = $('.resume-banner');
  dom.resumeText = $('.resume-text');
  dom.btnResume = $('.btn-resume');
  dom.btnRestart = $('.btn-restart');
}

// ─── Utilidades ───
function extractVideoId(url) {
  if (!url) return null;
  url = url.trim();
  let m;
  if ((m = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/))) return m[1];
  if ((m = url.match(/[?&]v=([a-zA-Z0-9_-]{11})/))) return m[1];
  if ((m = url.match(/embed\/([a-zA-Z0-9_-]{11})/))) return m[1];
  if ((m = url.match(/shorts\/([a-zA-Z0-9_-]{11})/))) return m[1];
  if (/^[a-zA-Z0-9_-]{11}$/.test(url)) return url;
  return null;
}

function escapeHtml(text) {
  const d = document.createElement('div');
  d.textContent = text;
  return d.innerHTML;
}

function formatTime(seconds) {
  if (!seconds || isNaN(seconds)) return '0:00';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function setStatus(text, type = '') {
  dom.statusText.textContent = text;
  dom.statusText.className = 'status-text' + (type ? ' ' + type : '');
}

function setButtonLoading(loading) {
  dom.btnPlay.disabled = loading;
  dom.btnPlay.innerHTML = loading
    ? '<span class="spinner"></span> Cargando...'
    : 'Reproducir';
}

// ═══════════════════════════════════════════════════════
// AUDIO SILENCIOSO - Mantiene la sesión de audio en iOS
// ═══════════════════════════════════════════════════════
// En PWA standalone, iOS suspende el WebView al bloquear
// la pantalla. Un <audio> nativo reproduciéndose mantiene
// la sesión activa y el iframe de YouTube sigue sonando.

function generateSilentWav() {
  const sampleRate = 8000;
  const seconds = 1;
  const numSamples = sampleRate * seconds;
  const buffer = new ArrayBuffer(44 + numSamples);
  const view = new DataView(buffer);

  const writeStr = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + numSamples, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true);   // chunk size
  view.setUint16(20, 1, true);    // PCM
  view.setUint16(22, 1, true);    // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate, true);
  view.setUint16(32, 1, true);    // block align
  view.setUint16(34, 8, true);    // 8 bits per sample
  writeStr(36, 'data');
  view.setUint32(40, numSamples, true);

  // Silencio: 128 = punto medio en audio unsigned 8-bit
  for (let i = 44; i < 44 + numSamples; i++) {
    view.setUint8(i, 128);
  }

  const blob = new Blob([buffer], { type: 'audio/wav' });
  return URL.createObjectURL(blob);
}

function startSilentAudio() {
  if (state.silentAudio) return; // ya activo

  const url = generateSilentWav();
  const audio = new Audio(url);
  audio.loop = true;
  audio.volume = 0.01; // Casi inaudible pero >0 (iOS ignora volume=0)
  audio.setAttribute('playsinline', '');
  audio.setAttribute('webkit-playsinline', '');

  audio.play().then(() => {
    console.log('Sesión de audio silencioso activa');
  }).catch((e) => {
    console.warn('No se pudo iniciar audio silencioso:', e);
  });

  state.silentAudio = audio;
}

function stopSilentAudio() {
  if (state.silentAudio) {
    state.silentAudio.pause();
    state.silentAudio = null;
  }
}

// ═══════════════════════════════════════════════════════
// YOUTUBE IFRAME PLAYER
// ═══════════════════════════════════════════════════════

function loadYouTubeAPI() {
  return new Promise((resolve) => {
    if (window.YT && window.YT.Player) { resolve(); return; }
    window.onYouTubeIframeAPIReady = resolve;
    const tag = document.createElement('script');
    tag.src = 'https://www.youtube.com/iframe_api';
    document.head.appendChild(tag);
  });
}

function createPlayer(videoId, startTime) {
  if (state.player) {
    try { state.player.destroy(); } catch {}
    state.player = null;
    state.playerReady = false;
  }

  dom.playerWrap.innerHTML = '<div id="yt-player"></div>';

  return new Promise((resolve) => {
    state.player = new YT.Player('yt-player', {
      videoId: videoId,
      host: 'https://www.youtube-nocookie.com',
      playerVars: {
        autoplay: 1,
        playsinline: 1,
        modestbranding: 1,
        rel: 0,
        fs: 1,
        iv_load_policy: 3,
        start: startTime ? Math.floor(startTime) : undefined,
        origin: location.origin
      },
      events: {
        onReady: (event) => {
          state.playerReady = true;
          setupMediaSession(event.target);
          resolve(event.target);
        },
        onStateChange: onPlayerStateChange,
        onError: (event) => {
          const errors = {
            2: 'ID de vídeo no válido',
            5: 'Error del reproductor HTML5',
            100: 'Vídeo no encontrado o privado',
            101: 'No permite reproducción embebida',
            150: 'No permite reproducción embebida'
          };
          setStatus(errors[event.data] || `Error (${event.data})`, 'error');
        }
      }
    });
  });
}

function onPlayerStateChange(event) {
  const code = event.data;

  if (code === YT.PlayerState.PLAYING) {
    setStatus('Reproduciendo', 'success');
    startSilentAudio(); // Mantener sesión de audio iOS
    startPositionSaving();
    updateMediaSessionState('playing');
    dom.timerSection.classList.add('active');
  } else if (code === YT.PlayerState.PAUSED) {
    savePosition();
    updateMediaSessionState('paused');
  } else if (code === YT.PlayerState.ENDED) {
    savePosition(true); // marcar como terminado
    stopPositionSaving();
    updateMediaSessionState('paused');
    playNextFromHistory();
  } else if (code === YT.PlayerState.BUFFERING) {
    setStatus('Cargando...', '');
  }
}

// ═══════════════════════════════════════════════════════
// REPRODUCCIÓN
// ═══════════════════════════════════════════════════════

async function playVideo(videoId, startTime) {
  setButtonLoading(true);
  setStatus('Cargando reproductor...');
  state.videoId = videoId;
  dom.resumeBanner.classList.remove('active');

  // Si no se especificó tiempo, comprobar si hay posición guardada
  const saved = getSavedPosition(videoId);
  if (startTime === undefined && saved && saved.time > 5) {
    // Mostrar banner de reanudación
    showResumeBanner(videoId, saved.time);
    setButtonLoading(false);
    return;
  }

  dom.playerSection.classList.add('active');

  // Iniciar audio silencioso en contexto de gesto de usuario
  startSilentAudio();

  try {
    await loadYouTubeAPI();
    const player = await createPlayer(videoId, startTime || 0);

    const videoData = player.getVideoData();
    const title = videoData.title || 'Vídeo de YouTube';
    const author = videoData.author || '';

    setStatus(title, 'success');
    addToHistory(videoId, title, author);
    setButtonLoading(false);
  } catch (err) {
    console.error('Error:', err);
    setStatus('Error al cargar el vídeo', 'error');
    setButtonLoading(false);
  }
}

// ═══════════════════════════════════════════════════════
// GUARDADO DE POSICIÓN
// ═══════════════════════════════════════════════════════

function savePosition(ended) {
  if (!state.player || !state.playerReady || !state.videoId) return;
  try {
    const time = ended ? 0 : state.player.getCurrentTime();
    const duration = state.player.getDuration();
    if (!duration) return;

    // No guardar si está al principio o al final
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
    // Ignorar posiciones de hace más de 30 días
    if (Date.now() - data.date > 30 * 24 * 60 * 60 * 1000) return null;
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
  dom.resumeBanner.classList.add('active');

  dom.btnResume.onclick = () => {
    dom.resumeBanner.classList.remove('active');
    playVideo(videoId, time);
  };
  dom.btnRestart.onclick = () => {
    dom.resumeBanner.classList.remove('active');
    clearSavedPosition(videoId);
    playVideo(videoId, 0);
  };
}

// ═══════════════════════════════════════════════════════
// TEMPORIZADOR (SLEEP TIMER)
// ═══════════════════════════════════════════════════════

function startTimer(minutes) {
  clearTimer();

  if (minutes <= 0) return;

  state.timerMinutes = minutes;
  state.timerEnd = Date.now() + minutes * 60 * 1000;

  // Marcar botón activo
  dom.timerButtons.querySelectorAll('.timer-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.timer) === minutes);
  });
  dom.timerOff.classList.remove('active');

  // Mostrar countdown
  dom.timerCountdown.classList.add('active');
  updateTimerDisplay();

  state.timerInterval = setInterval(() => {
    const remaining = state.timerEnd - Date.now();

    if (remaining <= 0) {
      // Tiempo agotado: pausar y guardar posición
      timerExpired();
      return;
    }

    // Fade out en los últimos 30 segundos
    if (remaining <= 30000 && state.silentAudio) {
      state.silentAudio.volume = Math.max(0.001, (remaining / 30000) * 0.01);
    }

    updateTimerDisplay();
  }, 1000);
}

function updateTimerDisplay() {
  if (!state.timerEnd) return;
  const remaining = Math.max(0, state.timerEnd - Date.now());
  const mins = Math.floor(remaining / 60000);
  const secs = Math.floor((remaining % 60000) / 1000);
  dom.timerCountdownTime.textContent = `${mins}:${secs.toString().padStart(2, '0')}`;
}

function timerExpired() {
  savePosition();

  if (state.player && state.playerReady) {
    state.player.pauseVideo();
  }

  clearTimer();
  setStatus('Temporizador: reproducción pausada', 'success');
}

function clearTimer() {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  state.timerEnd = null;
  state.timerMinutes = 0;
  dom.timerCountdown.classList.remove('active');
  dom.timerButtons.querySelectorAll('.timer-btn').forEach(btn => btn.classList.remove('active'));
  dom.timerOff.classList.add('active');

  // Restaurar volumen del audio silencioso
  if (state.silentAudio) state.silentAudio.volume = 0.01;
}

// ═══════════════════════════════════════════════════════
// MEDIA SESSION (controles en pantalla de bloqueo)
// ═══════════════════════════════════════════════════════

function setupMediaSession(player) {
  if (!('mediaSession' in navigator)) return;

  const videoData = player.getVideoData();

  navigator.mediaSession.metadata = new MediaMetadata({
    title: videoData.title || 'YouTube',
    artist: videoData.author || '',
    artwork: [
      { src: `https://i.ytimg.com/vi/${state.videoId}/hqdefault.jpg`, sizes: '480x360', type: 'image/jpeg' },
      { src: `https://i.ytimg.com/vi/${state.videoId}/maxresdefault.jpg`, sizes: '1280x720', type: 'image/jpeg' }
    ]
  });

  navigator.mediaSession.setActionHandler('play', () => {
    if (state.playerReady) state.player.playVideo();
  });
  navigator.mediaSession.setActionHandler('pause', () => {
    if (state.playerReady) state.player.pauseVideo();
  });
  navigator.mediaSession.setActionHandler('seekbackward', () => {
    if (state.playerReady) {
      state.player.seekTo(Math.max(0, state.player.getCurrentTime() - 15), true);
    }
  });
  navigator.mediaSession.setActionHandler('seekforward', () => {
    if (state.playerReady) {
      state.player.seekTo(state.player.getCurrentTime() + 15, true);
    }
  });
  navigator.mediaSession.setActionHandler('previoustrack', () => playPrevFromHistory());
  navigator.mediaSession.setActionHandler('nexttrack', () => playNextFromHistory());
}

function updateMediaSessionState(playbackState) {
  if ('mediaSession' in navigator) {
    navigator.mediaSession.playbackState = playbackState;
  }
}

// ═══════════════════════════════════════════════════════
// HISTORIAL
// ═══════════════════════════════════════════════════════

function addToHistory(videoId, title, author) {
  state.history = state.history.filter(h => h.id !== videoId);
  state.history.unshift({
    id: videoId,
    title,
    author,
    thumb: `https://i.ytimg.com/vi/${videoId}/default.jpg`
  });
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

function renderHistory() {
  if (state.history.length === 0) {
    dom.historyList.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">🎵</div>
        <p>Pega un enlace de YouTube<br>para empezar</p>
      </div>`;
    return;
  }

  dom.historyList.innerHTML = state.history.map(h => {
    const saved = getSavedPosition(h.id);
    const badge = saved && saved.time > 5
      ? `<span class="history-badge">${formatTime(saved.time)}</span>`
      : '';
    return `
      <div class="history-item" data-id="${h.id}">
        <img class="history-thumb" src="${h.thumb}" alt="" loading="lazy">
        <div class="history-info">
          <div class="history-info-title">${escapeHtml(h.title)}</div>
          <div class="history-info-author">${escapeHtml(h.author)}${badge}</div>
        </div>
        <button class="history-delete" data-delete="${h.id}" aria-label="Eliminar">✕</button>
      </div>`;
  }).join('');
}

function playNextFromHistory() {
  if (state.history.length < 2) return;
  const idx = state.history.findIndex(h => h.id === state.videoId);
  const next = (idx + 1) % state.history.length;
  playVideo(state.history[next].id);
}

function playPrevFromHistory() {
  if (state.history.length < 2) return;
  const idx = state.history.findIndex(h => h.id === state.videoId);
  const prev = (idx - 1 + state.history.length) % state.history.length;
  playVideo(state.history[prev].id);
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

// ─── Banner de instalación ───
function checkInstallBanner() {
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches
    || window.navigator.standalone === true;
  const dismissed = localStorage.getItem('install-dismissed');
  if (!isStandalone && !dismissed) {
    dom.installBanner.style.display = 'block';
  }
}

// ─── Guardar posición al cerrar/bloquear ───
function setupVisibilityHandler() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      savePosition();
    }
  });

  window.addEventListener('beforeunload', () => {
    savePosition();
  });
}

// ═══════════════════════════════════════════════════════
// INIT
// ═══════════════════════════════════════════════════════

function init() {
  initDOM();

  // Input
  dom.btnPaste.addEventListener('click', pasteFromClipboard);
  dom.btnPlay.addEventListener('click', handlePlayRequest);
  dom.urlInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') handlePlayRequest();
  });

  // Auto-pegar al focus
  dom.urlInput.addEventListener('focus', async () => {
    if (dom.urlInput.value === '') {
      try {
        const text = await navigator.clipboard.readText();
        if (extractVideoId(text)) dom.urlInput.value = text;
      } catch {}
    }
  });

  // Timer
  dom.timerButtons.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-timer]');
    if (!btn) return;
    const mins = parseInt(btn.dataset.timer);
    if (mins === 0) {
      clearTimer();
    } else {
      startTimer(mins);
    }
  });

  // Historial
  dom.historyList.addEventListener('click', (e) => {
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
  loadYouTubeAPI(); // pre-cargar
}

document.addEventListener('DOMContentLoaded', init);
