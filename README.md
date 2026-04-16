# YT Player

Reproductor de YouTube embebido, servido desde el Mac Mini por Tailscale. Diseñado para usarse como **marcador en Safari** en iOS, donde el audio sigue sonando con la pantalla bloqueada.

> **Nota:** En modo standalone (PWA añadida a pantalla de inicio), iOS suspende el WKWebView al bloquear pantalla y el audio del iframe se corta. Por eso se usa como marcador en Safari, no como PWA instalada.

---

## Funcionalidades

- **Reproductor YouTube embebido** via IFrame Player API
- **Audio en segundo plano** al bloquear pantalla (solo desde Safari, no desde PWA standalone)
- **Controles en pantalla de bloqueo** via Media Session API
- **Audio silencioso** de respaldo para reforzar la sesión de audio en iOS
- **Temporizador** (sleep timer): 15m, 30m, 45m, 1h, 1.5h
- **Guardado de posición**: automático cada 15s, al pausar, al bloquear pantalla. Al reabrir ofrece "Continuar desde X:XX"
- **Historial**: últimos 30 vídeos con thumbnails y badge de posición guardada

---

## Uso en iOS

1. Abrir en Safari: `https://mac-mini-de-arkakuso.tailef8025.ts.net:4447/`
2. Guardar como marcador (o añadir a favoritos).
3. Reproducir un vídeo → bloquear pantalla → el audio sigue.

---

## Estructura

```
yt-player/
├── server.js        Servidor Express (archivos estáticos)
├── app.js           Frontend: YouTube IFrame Player + timer + historial
├── index.html       HTML de la app
├── style.css        Estilos (tema oscuro, mobile-first)
├── sw.js            Service Worker (cache offline)
├── manifest.json    Manifiesto PWA
├── icon-192.svg     Icono 192px
├── icon-512.svg     Icono 512px
├── yt-flow          Script de ciclo de vida (start/stop/restart/status/logs)
└── package.json     Dependencias (express)
```

---

## yt-flow

Script bash que gestiona el ciclo de vida de la app.

### Comandos

```bash
./yt-flow start      # Arranca la app y publica por Tailscale Serve
./yt-flow stop       # Detiene la app y el Serve
./yt-flow restart    # Reinicia todo
./yt-flow status     # Muestra estado
./yt-flow logs       # Muestra logs en tiempo real
```

### Puertos

| Puerto | Default | Descripción |
|--------|---------|-------------|
| Local  | 4175    | Puerto del servidor Express |
| Tailscale HTTPS | 4447 | Puerto público en la Tailnet |

### Fallback de puertos

Si el puerto local (4175) está ocupado, busca uno libre en el rango **4175–4195**.
Si el puerto Tailscale HTTPS (4447) está ocupado, busca uno libre en el rango **4447–4487**.

El puerto efectivo se guarda en `.yt-flow.port` (local) y `.yt-flow.ts-port` (Tailscale).

### Variables de entorno

```bash
PORT=4175              # Puerto local (override)
TS_HTTPS_PORT=4447     # Puerto Tailscale (override)
```

### Ficheros de estado

| Fichero | Contenido |
|---------|-----------|
| `.yt-flow.pid` | PID del proceso Node.js |
| `.yt-flow.port` | Puerto local en uso |
| `.yt-flow.ts-port` | Puerto Tailscale HTTPS en uso |
| `.yt-flow.log` | Logs del servidor |
