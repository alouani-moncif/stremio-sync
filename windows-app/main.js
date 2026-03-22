const { app, BrowserWindow, ipcMain } = require("electron");
const { spawn } = require("child_process");
const net = require("net");
const path = require("path");
const WebSocket = require("ws");

// ─── Config ──────────────────────────────────────────────────────────────────
const SYNC_SERVER = process.env.SYNC_SERVER || "ws://localhost:3000";
const MPV_PATH = process.env.MPV_PATH || "C:\\Program Files\\mpv\\mpv.exe";
const MPV_PIPE = `\\\\.\\pipe\\stremio-sync-mpv-${Date.now()}`;

// ─── State ───────────────────────────────────────────────────────────────────
let bufferDebounce = null;
let mpvReady = false;
let mainWindow = null;
let mpvProcess = null;
let mpvSocket = null;
let syncSocket = null;
let syncingEvent = null;
let mpvCommandQueue = [];

// ─── Register as stremio:// protocol handler ─────────────────────────────────
if (process.defaultApp) {
  if (process.argv.length >= 2) {
    app.setAsDefaultProtocolClient("stremio", process.execPath, [path.resolve(process.argv[1])]);
  }
} else {
  app.setAsDefaultProtocolClient("stremio");
}

// ─── Single instance lock (handle protocol on Windows) ───────────────────────
//const gotLock = app.requestSingleInstanceLock();
//if (!gotLock) {
//  app.quit();
//} else {
//  app.on("second-instance", (event, commandLine) => {
//    const url = commandLine.find((arg) => arg.startsWith("stremio://"));
//    if (url) handleStremioUrl(url);
//    if (mainWindow) {
//      mainWindow.show();
//     mainWindow.focus();
//    }
//  });
//}

// ─── Create Window ───────────────────────────────────────────────────────────
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 480,
    height: 600,
    resizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
    },
    title: "Stremio-Sync",
  });
  mainWindow.loadFile("index.html");
}

app.whenReady().then(() => {
  createWindow();

  // Handle protocol URL passed on first launch
  const url = process.argv.find((arg) => arg.startsWith("stremio://"));
  if (url) handleStremioUrl(url);
});

app.on("open-url", (event, url) => {
  event.preventDefault();
  handleStremioUrl(url);
});

// ─── Extract stream URL from stremio:// protocol ─────────────────────────────
function handleStremioUrl(stremioUrl) {
  console.log("Intercepted stremio URL:", stremioUrl);
  try {
    const parsed = new URL(stremioUrl);
    // Stremio fires: stremio://stream/...?streamUrl=https://...
    const streamUrl = parsed.searchParams.get("streamUrl");
    if (streamUrl) {
      mainWindow?.webContents.send("stream-intercepted", streamUrl);
    }
  } catch (e) {
    console.error("Failed to parse stremio URL:", e);
  }
}

// ─── Launch MPV ──────────────────────────────────────────────────────────────
function launchMpv(url) {
  if (mpvProcess) {
    mpvProcess.kill();
    mpvProcess = null;
  }

  mpvProcess = spawn(MPV_PATH, [
    url,
    `--input-ipc-server=${MPV_PIPE}`,
    "--pause",           // start paused, wait for sync
    "--no-terminal",
    "--force-window=yes",
  ]);

  mpvProcess.on("exit", () => {
    mainWindow?.webContents.send("mpv-closed");
    mpvProcess = null;
    mpvSocket = null;
  });

  // Give MPV a moment to create the pipe
  setTimeout(() => connectMpvIpc(), 4000);
}

// ─── Connect to MPV IPC (named pipe) ─────────────────────────────────────────
function connectMpvIpc() {
  mpvSocket = net.createConnection(MPV_PIPE);
  let buffer = "";

	mpvSocket.on("connect", () => {
    console.log("Connected to MPV IPC");
    // Flush queued commands
    mpvCommandQueue.forEach((cmd) => sendMpvCommand(cmd));
    mpvCommandQueue = [];
    // Observe events we care about
    sendMpvCommand({ command: ["observe_property", 1, "pause"] });
    sendMpvCommand({ command: ["observe_property", 2, "time-pos"] });
    sendMpvCommand({ command: ["observe_property", 3, "paused-for-cache"] });
    // Mark MPV as ready after stream has had time to load
    setTimeout(() => { mpvReady = true; console.log("MPV ready for sync"); }, 3000);
	});

  mpvSocket.on("data", (data) => {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop();
    lines.forEach((line) => {
      if (!line.trim()) return;
      try {
        const msg = JSON.parse(line);
        handleMpvEvent(msg);
      } catch {}
    });
  });

  mpvSocket.on("error", (err) => {
    console.error("MPV IPC error:", err.message);
    setTimeout(() => connectMpvIpc(), 1000);
  });
}

function sendMpvCommand(cmd) {
  if (!mpvSocket || mpvSocket.destroyed) {
    mpvCommandQueue.push(cmd);
    return;
  }
  mpvSocket.write(JSON.stringify(cmd) + "\n");
}

// ─── Handle MPV events → send to sync server ─────────────────────────────────
let lastPause = null;
let lastTimestamp = 0;

function handleMpvEvent(msg) {
  if (syncingEvent === "pause" && msg.name === "pause") return;

  if (msg.event === "property-change") {
    if (msg.name === "pause") {
	  if (!mpvReady) return; 
      const paused = msg.data;
      if (paused === lastPause) return;
      lastPause = paused;
      if (!paused) {
        // Don't send play — send ready, let server coordinate
        sendMpvCommand({ command: ["set_property", "pause", true] });
        sendSync({ event: "ready", timestamp: lastTimestamp });
    } else {
        sendSync({ event: "pause", timestamp: lastTimestamp });
    }
    }

    if (msg.name === "time-pos" && msg.data != null) {
      const newTimestamp = msg.data;
      if (Math.abs(newTimestamp - lastTimestamp) > 3 && syncingEvent !== "seek") {
        sendSync({ event: "seek", timestamp: newTimestamp });
      }
      lastTimestamp = newTimestamp;
    }

    if (msg.name === "paused-for-cache") {
      clearTimeout(bufferDebounce);
      bufferDebounce = setTimeout(() => {
        sendSync({ event: msg.data ? "buffering-start" : "buffering-end", timestamp: lastTimestamp });
      }, 1000);
    }
  }
}

// ─── Sync server WebSocket ────────────────────────────────────────────────────
function connectSyncServer() {
  if (syncSocket) syncSocket.close();
  syncSocket = new WebSocket(SYNC_SERVER);

  syncSocket.on("open", () => {
    console.log("Connected to sync server");
    mainWindow?.webContents.send("sync-connected");
    startHeartbeat();
  });

  syncSocket.on("message", (raw) => {
    const msg = JSON.parse(raw);
    handleSyncEvent(msg);
  });

  syncSocket.on("close", () => {
    mainWindow?.webContents.send("sync-disconnected");
    setTimeout(() => connectSyncServer(), 3000);
  });

  syncSocket.on("error", (err) => console.error("Sync WS error:", err.message));
}

function sendSync(msg) {
  if (syncSocket?.readyState === WebSocket.OPEN) {
    syncSocket.send(JSON.stringify(msg));
  }
}

// ─── Handle sync server events → control MPV ─────────────────────────────────
function handleSyncEvent(msg) {

  switch (msg.event) {
    case "room-created":
      mainWindow?.webContents.send("room-created", msg.code);
      break;

    case "room-joined":
      mainWindow?.webContents.send("room-joined", { code: msg.code, url: msg.url });
      launchMpv(msg.url);
      break;

    case "peer-connected":
      mainWindow?.webContents.send("peer-connected");
      break;

    case "peer-disconnected":
      mainWindow?.webContents.send("peer-disconnected");
      break;

	case "play":
		sendMpvCommand({ command: ["set_property", "pause", false] });
	break;

	case "pause":
		sendMpvCommand({ command: ["set_property", "pause", true] });
	break;

    case "seek":
		if (mpvReady) {
			sendMpvCommand({ command: ["seek", msg.timestamp, "absolute"] });
		}
	break;

    case "buffering-start":
      sendMpvCommand({ command: ["set_property", "pause", true] });
      mainWindow?.webContents.send("peer-buffering", true);
      break;

    case "buffering-end-all":
      sendMpvCommand({ command: ["seek", msg.timestamp, "absolute"] });
      sendMpvCommand({ command: ["set_property", "pause", false] });
      mainWindow?.webContents.send("peer-buffering", false);
      break;

    case "error":
      mainWindow?.webContents.send("sync-error", msg.message);
      break;
  }

syncingEvent = msg.event;
setTimeout(() => { syncingEvent = null; }, 1500);
}

// ─── Heartbeat ───────────────────────────────────────────────────────────────
function startHeartbeat() {
  setInterval(() => {
    sendSync({ event: "ping" });
  }, 30000);
}

// ─── IPC from renderer ───────────────────────────────────────────────────────
ipcMain.on("create-room", (event, url) => {
  launchMpv(url);
  sendSync({ event: "create-room", url });
});

ipcMain.on("join-room", (event, code) => {
  sendSync({ event: "join-room", code });
});

ipcMain.on("connect-sync", () => {
  connectSyncServer();
});
