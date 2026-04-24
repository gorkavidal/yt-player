const express = require('express');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const os = require('os');

const app = express();
const PORT = Number(process.env.PORT || 4175);

// ── Directorio para vídeos descargados ──────────────
const VIDEOS_DIR = path.join(os.tmpdir(), 'yt-player-cache');
if (!fs.existsSync(VIDEOS_DIR)) fs.mkdirSync(VIDEOS_DIR, { recursive: true });

// ── Cache de info ───────────────────────────────────
const infoCache = new Map();
const INFO_TTL = 6 * 3600000;

// ── Descargas en curso ──────────────────────────────
const downloads = new Map(); // videoId -> { promise, progress }

function getInfo(videoId) {
  const hit = infoCache.get(videoId);
  if (hit && Date.now() - hit.ts < INFO_TTL) return Promise.resolve(hit.data);

  return new Promise((resolve, reject) => {
    execFile('yt-dlp', [
      '-j', '--no-playlist', '--no-warnings',
      `https://www.youtube.com/watch?v=${videoId}`
    ], { timeout: 30000, maxBuffer: 10 << 20 }, (err, stdout) => {
      if (err) return reject(err);
      try {
        const info = JSON.parse(stdout);
        const data = {
          title: info.title || 'YouTube',
          author: info.uploader || info.channel || '',
          duration: info.duration || 0,
          thumb: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
        };
        infoCache.set(videoId, { data, ts: Date.now() });
        resolve(data);
      } catch (e) { reject(e); }
    });
  });
}

function getVideoPath(videoId) {
  return path.join(VIDEOS_DIR, `${videoId}.mp4`);
}

function isVideoReady(videoId) {
  const p = getVideoPath(videoId);
  return fs.existsSync(p) && fs.statSync(p).size > 0;
}

function downloadVideo(videoId) {
  // Ya descargado
  if (isVideoReady(videoId)) return Promise.resolve(getVideoPath(videoId));

  // Ya descargando
  if (downloads.has(videoId)) return downloads.get(videoId).promise;

  // Registrar el slot inmediatamente (sin await) para evitar race conditions
  const state = { progress: 0 };
  const promise = _doDownload(videoId, state);
  downloads.set(videoId, { promise, state });
  return promise;
}

async function _doDownload(videoId, state) {
  const filePath = getVideoPath(videoId);
  const tempBase = path.join(VIDEOS_DIR, `${videoId}.downloading`);

  // Decidir resolución según duración: >1h baja a 480p para no reventar
  // la cuota de IndexedDB en iOS (~1-2 GB) ni la memoria del navegador.
  let maxHeight = 720;
  try {
    const info = await getInfo(videoId);
    if (info.duration > 3600) maxHeight = 480;  // >1h
    if (info.duration > 7200) maxHeight = 360;  // >2h
  } catch {}

  const fmt =
    `bestvideo[height<=${maxHeight}][vcodec^=avc1][ext=mp4]+bestaudio[ext=m4a]/` +
    `bestvideo[height<=${maxHeight}][vcodec^=avc1]+bestaudio/` +
    `best[height<=${maxHeight}][vcodec^=avc1]`;

  return new Promise((resolve, reject) => {
    // Limpiar vídeos anteriores del servidor (solo 1 en disco)
    try {
      const files = fs.readdirSync(VIDEOS_DIR);
      for (const f of files) {
        if (f.endsWith('.mp4') && !f.startsWith(videoId)) {
          fs.unlinkSync(path.join(VIDEOS_DIR, f));
        }
      }
    } catch {}

    const proc = spawn('yt-dlp', [
      '-f', fmt,
      '--merge-output-format', 'mp4',
      '--no-playlist', '--no-warnings',
      '--newline',           // progreso línea a línea
      '-o', tempBase + '.%(ext)s',
      `https://www.youtube.com/watch?v=${videoId}`
    ], { timeout: 1800000 });  // 30 min (antes 5 min, insuficiente para vídeos largos)

    let stderr = '';

    proc.stdout.on('data', (chunk) => {
      const line = chunk.toString();
      const m = line.match(/(\d+\.?\d*)%/);
      if (m) state.progress = Math.floor(parseFloat(m[1]));
    });

    proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });

    proc.on('close', async (code) => {
      if (code !== 0) {
        downloads.delete(videoId);
        // Limpiar restos parciales
        try {
          const files = fs.readdirSync(VIDEOS_DIR);
          for (const f of files) {
            if (f.includes('downloading')) fs.unlinkSync(path.join(VIDEOS_DIR, f));
          }
        } catch {}
        return reject(new Error(stderr.slice(-200) || `yt-dlp exit ${code}`));
      }
      // Renombrar el resultado a nombre final
      try {
        const resultPath = tempBase + '.mp4';
        if (fs.existsSync(resultPath) && fs.statSync(resultPath).size > 0) {
          fs.renameSync(resultPath, filePath);
        }
        // Limpiar restos parciales
        const files = fs.readdirSync(VIDEOS_DIR);
        for (const f of files) {
          if (f.includes('downloading')) {
            fs.unlinkSync(path.join(VIDEOS_DIR, f));
          }
        }
      } catch {}

      // Remux a fragmented MP4 para reproducción vía MediaSource.
      // MSE no soporta MP4 tradicional (moov al final), solo fMP4.
      // Es remux puro, no re-encoding → rápido.
      if (isVideoReady(videoId)) {
        try {
          await remuxToFmp4(filePath);
        } catch (e) {
          console.warn(`[remux] fMP4 falló para ${videoId}: ${e.message}. Se sirve MP4 sin fragmentar.`);
        }
      }

      downloads.delete(videoId);
      if (isVideoReady(videoId)) {
        resolve(filePath);
      } else {
        reject(new Error('Descarga incompleta'));
      }
    });

    proc.on('error', (e) => {
      downloads.delete(videoId);
      reject(e);
    });
  });
}

// ── fMP4 remux (para MediaSource) ───────────────────
function remuxToFmp4(filePath) {
  return new Promise((resolve, reject) => {
    const tmpPath = filePath + '.fmp4.tmp';
    const proc = spawn('ffmpeg', [
      '-nostdin', '-loglevel', 'error',
      '-i', filePath,
      '-c', 'copy',
      '-movflags', 'empty_moov+frag_keyframe+default_base_moof',
      '-f', 'mp4',
      '-y', tmpPath
    ], { timeout: 300000 });  // 5 min max remux

    let stderr = '';
    proc.stderr.on('data', c => { stderr += c.toString(); });

    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(tmpPath) && fs.statSync(tmpPath).size > 0) {
        try {
          fs.renameSync(tmpPath, filePath);
          resolve();
        } catch (e) { reject(e); }
      } else {
        try { fs.unlinkSync(tmpPath); } catch {}
        reject(new Error(stderr.slice(-200) || `ffmpeg exit ${code}`));
      }
    });
    proc.on('error', reject);
  });
}

// ── ffprobe: detectar codecs para addSourceBuffer ───
function detectCodecs(filePath) {
  return new Promise((resolve) => {
    execFile('ffprobe', [
      '-v', 'error',
      '-show_entries', 'stream=codec_name,codec_tag_string,profile,level',
      '-of', 'json',
      filePath
    ], { timeout: 10000 }, (err, stdout) => {
      if (err) return resolve(null);
      try {
        const data = JSON.parse(stdout);
        const streams = data.streams || [];
        const v = streams.find(s => s.codec_name && s.codec_name !== 'aac');
        const a = streams.find(s => s.codec_name === 'aac');

        // Construir strings compatibles con MediaSource.isTypeSupported()
        // Para H.264: avc1.PPCCLL (hex) donde PP=profile_idc, CC=constraint, LL=level
        // Para AAC-LC: mp4a.40.2
        let videoCodec = 'avc1.4d401f';  // fallback: baseline-ish
        if (v && v.codec_tag_string === 'avc1' && typeof v.profile === 'string') {
          const profileMap = { 'Baseline': '42', 'Main': '4d', 'High': '64' };
          const pp = profileMap[v.profile] || '4d';
          const lvl = v.level ? v.level.toString(16).padStart(2, '0') : '1f';
          videoCodec = `avc1.${pp}401${lvl[lvl.length - 1] || 'f'}`;
        }
        resolve({
          video: videoCodec,
          audio: a ? 'mp4a.40.2' : null,
          combined: a ? `${videoCodec},mp4a.40.2` : videoCodec
        });
      } catch {
        resolve(null);
      }
    });
  });
}

const validId = id => /^[a-zA-Z0-9_-]{11}$/.test(id);

// ── API: info ───────────────────────────────────────
app.get('/api/info/:id', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'ID no válido' });
  try {
    const info = await getInfo(req.params.id);
    const cached = isVideoReady(req.params.id);

    let size = 0;
    let codecs = null;
    if (cached) {
      const fp = getVideoPath(req.params.id);
      try { size = fs.statSync(fp).size; } catch {}
      codecs = await detectCodecs(fp);
    }

    res.json({ ...info, cached, size, codecs });
  } catch (e) {
    console.error('[info]', req.params.id, e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── API: iniciar descarga ───────────────────────────
app.get('/api/download/:id', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'ID no válido' });
  try {
    if (isVideoReady(req.params.id)) {
      return res.json({ status: 'ready' });
    }
    // Iniciar descarga en background, no esperar
    downloadVideo(req.params.id).catch(() => {});
    res.json({ status: 'downloading' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── API: progreso de descarga ───────────────────────
app.get('/api/progress/:id', (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'ID no válido' });
  if (isVideoReady(req.params.id)) return res.json({ status: 'ready', progress: 100 });
  const dl = downloads.get(req.params.id);
  if (dl) return res.json({ status: 'downloading', progress: dl.state.progress });
  res.json({ status: 'none', progress: 0 });
});

// ── API: stream del vídeo ───────────────────────────
app.get('/api/stream/:id', async (req, res) => {
  if (!validId(req.params.id)) return res.status(400).json({ error: 'ID no válido' });

  // Si no está descargado, iniciar descarga y esperar
  if (!isVideoReady(req.params.id)) {
    try {
      await downloadVideo(req.params.id);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  const filePath = getVideoPath(req.params.id);
  const stat = fs.statSync(filePath);
  const fileSize = stat.size;

  // Range requests para seeking
  const range = req.headers.range;
  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    const chunkSize = end - start + 1;

    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': chunkSize,
      'Content-Type': 'video/mp4',
      'Cache-Control': 'public, max-age=86400'
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, {
      'Content-Length': fileSize,
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400'
    });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ── Archivos estáticos ──────────────────────────────
app.use(express.static(__dirname, { index: 'index.html' }));
app.get('*', (_, res) => res.sendFile(path.join(__dirname, 'index.html')));

app.listen(PORT, () => console.log(`YT Player → http://localhost:${PORT}`));
