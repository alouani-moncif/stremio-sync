const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

// rooms[code] = { url, state, timestamp, bufferingClients: Set, clients: Map<id, ws> }
const rooms = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function broadcastToRoom(roomCode, senderId, message) {
  const room = rooms[roomCode];
  if (!room) return;
  const data = JSON.stringify(message);
  room.clients.forEach((ws, clientId) => {
    if (clientId !== senderId && ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

function broadcastToAll(roomCode, message) {
  const room = rooms[roomCode];
  if (!room) return;
  const data = JSON.stringify(message);
  room.clients.forEach((ws) => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
}

function cleanupClient(clientId, roomCode) {
  const room = rooms[roomCode];
  if (!room) return;

  room.clients.delete(clientId);
  room.bufferingClients.delete(clientId);

  broadcastToAll(roomCode, {
    event: "peer-disconnected",
    clientId,
    peerCount: room.clients.size,
  });

  // Delete room if empty
  if (room.clients.size === 0) {
    delete rooms[roomCode];
    console.log(`Room ${roomCode} deleted (empty)`);
  }
}

wss.on("connection", (ws) => {
  let clientId = uuidv4();
  let currentRoom = null;

  console.log(`Client connected: ${clientId}`);

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      ws.send(JSON.stringify({ event: "error", message: "Invalid JSON" }));
      return;
    }

    switch (msg.event) {

      // ─── HOST CREATES ROOM ───────────────────────────────────────────
      case "create-room": {
        const code = generateCode();
        rooms[code] = {
          url: msg.url,
          state: "paused",
          timestamp: 0,
          bufferingClients: new Set(),
          clients: new Map([[clientId, ws]]),
          host: clientId,
        };
        currentRoom = code;
        ws.send(JSON.stringify({ event: "room-created", code, clientId }));
        console.log(`Room created: ${code} by ${clientId}`);
        break;
      }

      // ─── GUEST JOINS ROOM ────────────────────────────────────────────
      case "join-room": {
        const room = rooms[msg.code];
        if (!room) {
          ws.send(JSON.stringify({ event: "error", message: "Room not found" }));
          return;
        }
        if (room.clients.size >= 2) {
          ws.send(JSON.stringify({ event: "error", message: "Room is full" }));
          return;
        }
        room.clients.set(clientId, ws);
        currentRoom = msg.code;

        // Send room state to guest so they can start playback
        ws.send(JSON.stringify({
          event: "room-joined",
          code: msg.code,
          clientId,
          url: room.url,
          state: room.state,
          timestamp: room.timestamp,
        }));

        // Notify host that guest joined
        broadcastToRoom(msg.code, clientId, {
          event: "peer-connected",
          peerCount: room.clients.size,
        });

        console.log(`Client ${clientId} joined room ${msg.code}`);
        break;
      }

      // ─── PLAY ────────────────────────────────────────────────────────
      case "play": {
        if (!currentRoom || !rooms[currentRoom]) return;
        rooms[currentRoom].state = "playing";
        rooms[currentRoom].timestamp = msg.timestamp;
        broadcastToRoom(currentRoom, clientId, {
          event: "play",
          timestamp: msg.timestamp,
        });
        break;
      }

      // ─── PAUSE ───────────────────────────────────────────────────────
      case "pause": {
        if (!currentRoom || !rooms[currentRoom]) return;
        rooms[currentRoom].state = "paused";
        rooms[currentRoom].timestamp = msg.timestamp;
        broadcastToRoom(currentRoom, clientId, {
          event: "pause",
          timestamp: msg.timestamp,
        });
        break;
      }

      // ─── SEEK ────────────────────────────────────────────────────────
      case "seek": {
        if (!currentRoom || !rooms[currentRoom]) return;
        rooms[currentRoom].timestamp = msg.timestamp;
        broadcastToRoom(currentRoom, clientId, {
          event: "seek",
          timestamp: msg.timestamp,
        });
        break;
      }

      // ─── BUFFERING ───────────────────────────────────────────────────
      case "buffering-start": {
        if (!currentRoom || !rooms[currentRoom]) return;
        rooms[currentRoom].bufferingClients.add(clientId);
        // Tell everyone to pause and wait
        broadcastToAll(currentRoom, {
          event: "buffering-start",
          clientId,
        });
        break;
      }

      case "buffering-end": {
        if (!currentRoom || !rooms[currentRoom]) return;
        rooms[currentRoom].bufferingClients.delete(clientId);
        // Only resume if nobody is buffering
        if (rooms[currentRoom].bufferingClients.size === 0) {
          broadcastToAll(currentRoom, {
            event: "buffering-end-all",
            timestamp: msg.timestamp,
          });
        }
        break;
      }

      // ─── HEARTBEAT ───────────────────────────────────────────────────
      case "ping": {
        ws.send(JSON.stringify({ event: "pong" }));
        break;
      }

      default:
        ws.send(JSON.stringify({ event: "error", message: `Unknown event: ${msg.event}` }));
    }
  });

  ws.on("close", () => {
    console.log(`Client disconnected: ${clientId}`);
    if (currentRoom) cleanupClient(clientId, currentRoom);
  });

  ws.on("error", (err) => {
    console.error(`Client ${clientId} error:`, err.message);
    if (currentRoom) cleanupClient(clientId, currentRoom);
  });
});

console.log(`Stremio-Sync server running on port ${PORT}`);
