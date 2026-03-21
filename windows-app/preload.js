const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("sync", {
  onStreamIntercepted: (cb) => ipcRenderer.on("stream-intercepted", (_, url) => cb(url)),
  onRoomCreated: (cb) => ipcRenderer.on("room-created", (_, code) => cb(code)),
  onRoomJoined: (cb) => ipcRenderer.on("room-joined", (_, data) => cb(data)),
  onPeerConnected: (cb) => ipcRenderer.on("peer-connected", () => cb()),
  onPeerDisconnected: (cb) => ipcRenderer.on("peer-disconnected", () => cb()),
  onPeerBuffering: (cb) => ipcRenderer.on("peer-buffering", (_, val) => cb(val)),
  onSyncConnected: (cb) => ipcRenderer.on("sync-connected", () => cb()),
  onSyncDisconnected: (cb) => ipcRenderer.on("sync-disconnected", () => cb()),
  onSyncError: (cb) => ipcRenderer.on("sync-error", (_, msg) => cb(msg)),
  onMpvClosed: (cb) => ipcRenderer.on("mpv-closed", () => cb()),

  createRoom: (url) => ipcRenderer.send("create-room", url),
  joinRoom: (code) => ipcRenderer.send("join-room", code),
  connect: () => ipcRenderer.send("connect-sync"),
});
