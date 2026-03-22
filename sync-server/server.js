const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");

const PORT = process.env.PORT || 3000;
const wss = new WebSocket.Server({ port: PORT });

// rooms[code] = { url, state, timestamp, bufferingClients, readyClients, clients, host }
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
  room.readyClients.delete(clientId);

  if (room.clients.size === 0) {
    delete rooms[roomCode];
    console.log(`Room ${roomCode} deleted (empty)`);
    return;
  }

  // Notify remaining client
  broadcastToAll(roomCode, {
    event: "peer-disconnected",
    clientId,
    peerCount: room.clients.size,
  });

  // If remaining client was waiting for ready, unblock them immediately
  if (room.readyClients.size > 0) {
    console.log(`Room ${roomCode}: partner left while ready pending — firing play`);
    room.readyClients.clear();
    room.state = "playing";
    broadcastToAll(roomCode, { event: "play", timestamp: room.timestamp });
  }

  // If remaining client was waiting on buffering, unblock
  if (room.bufferingClients.size === 0) {
    // only unblock if we were actually in a buffering-start state
    // (don't fire spurious buffering-end-all on random disconnects)
  }
}

wss.on("connection", (ws) => {
  const clientId = uuidv4();
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
          readyClients: new Set(),
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

        ws.send(JSON.stringify({
          event: "room-joined",
          code: msg.code,
          clientId,
          url: room.url,
          state: room.state,
          timestamp: room.timestamp,
        }));

        broadcastToRoom(msg.code, clientId, {
          event: "peer-connected",
          peerCount: room.clients.size,
        });

        console.log(`Client ${clientId} joined room ${msg.code}`);
        break;
      }

      // ─── READY TO PLAY ───────────────────────────────────────────────
      case "ready": {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];

        room.readyClients.add(clientId);
        room.timestamp = msg.timestamp; // update timestamp from whoever just sent ready

        console.log(`Room ${currentRoom}: ${room.readyClients.size}/${room.clients.size} ready`);

        // Tell partner this client is ready
        broadcastToRoom(currentRoom, clientId, { event: "peer-ready" });

        // Fire play when ALL clients are ready
        if (room.readyClients.size >= room.clients.size) {
          room.readyClients.clear();
          room.bufferingClients.clear();
          room.state = "playing";
          console.log(`Room ${currentRoom}: all ready → play at ${room.timestamp}`);
          broadcastToAll(currentRoom, { event: "play", timestamp: room.timestamp });
        }
        break;
      }

      // ─── PAUSE ───────────────────────────────────────────────────────
      case "pause": {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        room.state = "paused";
        room.timestamp = msg.timestamp;
        room.readyClients.clear(); // cancel any pending ready coordination
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
        const room = rooms[currentRoom];
        room.bufferingClients.add(clientId);
        room.readyClients.clear(); // cancel any pending ready
        broadcastToAll(currentRoom, { event: "buffering-start", clientId });
        break;
      }

      case "buffering-end": {
        if (!currentRoom || !rooms[currentRoom]) return;
        const room = rooms[currentRoom];
        room.bufferingClients.delete(clientId);
        if (room.bufferingClients.size === 0) {
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
