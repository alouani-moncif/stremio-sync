# Stremio-Sync

Watch movies in sync with your partner. Each person controls their own subtitles, audio track, and volume — but play/pause/seek/buffering is perfectly synced.

---

## Architecture

```
Stremio (URL source)
    ↓ intercepts "open in external player"
Your App (Windows / Android TV)
    ↓ MPV IPC (named pipe / unix socket)
MPV Player
    ↓ WebSocket
Sync Server (Render.com, free)
    ↓ WebSocket
Her App (Windows / Android TV)
    ↓ MPV IPC
MPV Player
```

---

## Project Structure

```
stremio-sync/
├── sync-server/        Node.js WebSocket relay server
├── windows-app/        Electron app (Windows)
└── android-tv-app/     Android TV app (Kotlin)
```

---

## Setup

### 1. Sync Server

```bash
cd sync-server
npm install
node server.js   # runs on port 3000
```

**Deploy to Render.com (free):**
- Push to GitHub
- New Web Service → connect repo → Root: `sync-server`
- Build: `npm install` | Start: `node server.js`
- Copy your Render URL (e.g. `wss://stremio-sync-server.onrender.com`)

---

### 2. Windows App

```bash
cd windows-app
npm install
```

Set your server URL in `main.js`:
```js
const SYNC_SERVER = "wss://your-render-url.onrender.com";
```

Set your MPV path if not in PATH:
```js
const MPV_PATH = "C:\\path\\to\\mpv.exe";
```

Run:
```bash
npm start
```

Build .exe:
```bash
npm run build
```

---

### 3. Android TV App

- Open `android-tv-app` in Android Studio
- Set your server URL in `SyncManager.kt`:
```kotlin
const val SERVER_URL = "wss://your-render-url.onrender.com"
```
- Build & sideload to Android TV (or use emulator)
- Install **MPV for Android** from: https://github.com/mpv-android/mpv-android/releases

---

## How to Use

### Host (you)
1. Open Stremio, find your movie
2. Click "Open in external player" → Stremio-Sync intercepts the URL
3. App shows a **room code** (e.g. `ABC123`)
4. Send the code to your partner over WhatsApp

### Guest (your partner)
1. Open Stremio-Sync
2. Enter the room code
3. MPV launches automatically with the same URL
4. Sync starts — either person can play/pause/seek

---

## What syncs / what doesn't

| Feature | Synced |
|---|---|
| Play / Pause | ✅ |
| Seek / Skip | ✅ |
| Buffering wait | ✅ |
| Subtitles | ❌ (independent) |
| Audio track | ❌ (independent) |
| Volume | ❌ (independent) |

---

## Requirements

- **MPV** installed (Windows) or **MPV for Android** sideloaded (Android TV)
- **Node.js 20+** for the server
- **Stremio** + Torbox account (existing setup)
