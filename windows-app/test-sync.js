const WebSocket = require("ws");

const SERVER = "ws://localhost:3000";
const TEST_URL = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";

// ─── Colors ──────────────────────────────────────────────────────────────────
const GREEN = "\x1b[32m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN = "\x1b[36m";
const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";

let passed = 0;
let failed = 0;
let results = [];

function log(msg) { console.log(msg); }
function ok(test) {
  passed++;
  results.push({ test, ok: true });
  log(`  ${GREEN}✓${RESET} ${test}`);
}
function fail(test, reason) {
  failed++;
  results.push({ test, ok: false, reason });
  log(`  ${RED}✗${RESET} ${test}${reason ? ` — ${RED}${reason}${RESET}` : ""}`);
}

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER);
    ws.on("open", () => resolve(ws));
    ws.on("error", (e) => reject(new Error(`${label} connection failed: ${e.message}`)));
    setTimeout(() => reject(new Error(`${label} connection timeout`)), 5000);
  });
}

function waitForEvent(ws, eventName, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Timeout waiting for "${eventName}"`)), timeoutMs);
    ws.on("message", function handler(raw) {
      try {
        const msg = JSON.parse(raw);
        if (msg.event === eventName) {
          clearTimeout(timer);
          ws.off("message", handler);
          resolve(msg);
        }
      } catch {}
    });
  });
}

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

// ─── TESTS ───────────────────────────────────────────────────────────────────

async function testConnection(wsA, wsB) {
  log(`\n${CYAN}${BOLD}[ 1. Connection ]${RESET}`);
  try {
    ok("Client A connected to server");
    ok("Client B connected to server");
  } catch (e) {
    fail("Connection", e.message);
  }
}

async function testRoomCreate(wsA) {
  log(`\n${CYAN}${BOLD}[ 2. Room Creation ]${RESET}`);
  send(wsA, { event: "create-room", url: TEST_URL });
  try {
    const msg = await waitForEvent(wsA, "room-created");
    if (msg.code && msg.code.length >= 4) {
      ok(`Room created with code: ${BOLD}${msg.code}${RESET}`);
      return msg.code;
    } else {
      fail("Room creation", "No room code returned");
      return null;
    }
  } catch (e) {
    fail("Room creation", e.message);
    return null;
  }
}

async function testRoomJoin(wsA, wsB, code) {
  log(`\n${CYAN}${BOLD}[ 3. Room Join ]${RESET}`);
  send(wsB, { event: "join-room", code });

  try {
    const [joinMsg, peerMsg] = await Promise.all([
      waitForEvent(wsB, "room-joined"),
      waitForEvent(wsA, "peer-connected"),
    ]);
    ok("Client B received room-joined with URL");
    ok("Client A notified of peer connection");
    if (joinMsg.url === TEST_URL) {
      ok("URL correctly transmitted to guest");
    } else {
      fail("URL transmission", `Expected ${TEST_URL}, got ${joinMsg.url}`);
    }
  } catch (e) {
    fail("Room join", e.message);
  }
}

async function testPlay(wsA, wsB) {
  log(`\n${CYAN}${BOLD}[ 4. Play Sync ]${RESET}`);
  send(wsA, { event: "play", timestamp: 10.0 });
  try {
    const msg = await waitForEvent(wsB, "play");
    ok("Play event received by Client B");
    if (Math.abs(msg.timestamp - 10.0) < 0.1) {
      ok(`Timestamp synced correctly (${msg.timestamp}s)`);
    } else {
      fail("Timestamp sync", `Expected 10.0, got ${msg.timestamp}`);
    }
  } catch (e) {
    fail("Play sync", e.message);
  }
}

async function testPause(wsA, wsB) {
  log(`\n${CYAN}${BOLD}[ 5. Pause Sync ]${RESET}`);
  send(wsA, { event: "pause", timestamp: 15.5 });
  try {
    const msg = await waitForEvent(wsB, "pause");
    ok("Pause event received by Client B");
    if (Math.abs(msg.timestamp - 15.5) < 0.1) {
      ok(`Timestamp synced correctly (${msg.timestamp}s)`);
    } else {
      fail("Timestamp sync", `Expected 15.5, got ${msg.timestamp}`);
    }
  } catch (e) {
    fail("Pause sync", e.message);
  }
}

async function testSeek(wsA, wsB) {
  log(`\n${CYAN}${BOLD}[ 6. Seek Sync ]${RESET}`);
  send(wsA, { event: "seek", timestamp: 120.0 });
  try {
    const msg = await waitForEvent(wsB, "seek");
    ok("Seek event received by Client B");
    if (Math.abs(msg.timestamp - 120.0) < 0.1) {
      ok(`Seek timestamp correct (${msg.timestamp}s)`);
    } else {
      fail("Seek timestamp", `Expected 120.0, got ${msg.timestamp}`);
    }
  } catch (e) {
    fail("Seek sync", e.message);
  }
}

async function testSeekNoFeedback(wsA, wsB) {
  log(`\n${CYAN}${BOLD}[ 7. Seek Feedback Loop Prevention ]${RESET}`);
  // B seeks, A should get it — but B should NOT get it back
  let feedbackReceived = false;
  const feedbackListener = (raw) => {
    try {
      const msg = JSON.parse(raw);
      if (msg.event === "seek") feedbackReceived = true;
    } catch {}
  };
  wsB.on("message", feedbackListener);
  send(wsB, { event: "seek", timestamp: 200.0 });

  try {
    await waitForEvent(wsA, "seek");
    ok("Seek from B received by A");
    await wait(500); // wait to see if B gets feedback
    wsB.off("message", feedbackListener);
    if (!feedbackReceived) {
      ok("No feedback loop — B did not receive its own seek back");
    } else {
      fail("Feedback loop", "B received its own seek event back from server");
    }
  } catch (e) {
    fail("Seek feedback test", e.message);
  }
}

async function testBuffering(wsA, wsB) {
  log(`\n${CYAN}${BOLD}[ 8. Buffering Sync ]${RESET}`);
  send(wsA, { event: "buffering-start", timestamp: 50.0 });
  try {
    const startMsg = await waitForEvent(wsB, "buffering-start", 3000);
    ok("Buffering-start received by Client B");

    await wait(300);
    send(wsA, { event: "buffering-end", timestamp: 50.5 });
    const endMsg = await waitForEvent(wsB, "buffering-end-all", 3000);
    ok("Buffering-end-all received by Client B");
    ok(`Resume timestamp: ${endMsg.timestamp}s`);
  } catch (e) {
    fail("Buffering sync", e.message);
  }
}

async function testBidirectional(wsA, wsB) {
  log(`\n${CYAN}${BOLD}[ 9. Bidirectional Control ]${RESET}`);
  // B controls, A should receive
  send(wsB, { event: "play", timestamp: 300.0 });
  try {
    const msg = await waitForEvent(wsA, "play");
    ok("B can control A (bidirectional confirmed)");
    if (Math.abs(msg.timestamp - 300.0) < 0.1) {
      ok(`Timestamp correct from B→A (${msg.timestamp}s)`);
    } else {
      fail("B→A timestamp", `Expected 300.0, got ${msg.timestamp}`);
    }
  } catch (e) {
    fail("Bidirectional control", e.message);
  }
}

async function testReconnection() {
  log(`\n${CYAN}${BOLD}[ 10. Reconnection ]${RESET}`);
  log(`  ${YELLOW}ℹ${RESET}  Closing client and reconnecting...`);
  try {
    const wsTemp = await connect("Reconnect client");
    ok("Client reconnected to server successfully");

    // Try creating a room after reconnect
    send(wsTemp, { event: "create-room", url: TEST_URL });
    const msg = await waitForEvent(wsTemp, "room-created");
    ok(`Room created after reconnect (code: ${msg.code})`);
    wsTemp.close();
  } catch (e) {
    fail("Reconnection", e.message);
  }
}

async function testPeerDisconnect(wsA, wsB) {
  log(`\n${CYAN}${BOLD}[ 11. Peer Disconnect Notification ]${RESET}`);
  try {
    // Connect a fresh pair
    const tempA = await connect("TempA");
    const tempB = await connect("TempB");

    send(tempA, { event: "create-room", url: TEST_URL });
    const { code } = await waitForEvent(tempA, "room-created");
    send(tempB, { event: "join-room", code });
    await waitForEvent(tempB, "room-joined");
    await waitForEvent(tempA, "peer-connected");

    // Now disconnect B
    tempB.close();
    const msg = await waitForEvent(tempA, "peer-disconnected", 3000);
    ok("Host notified when guest disconnects");
    tempA.close();
  } catch (e) {
    fail("Peer disconnect notification", e.message);
  }
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function runTests() {
  log(`\n${BOLD}================================${RESET}`);
  log(`${BOLD} Stremio-Sync Automated Tests${RESET}`);
  log(`${BOLD}================================${RESET}`);
  log(`  Server: ${SERVER}`);
  log(`  Time:   ${new Date().toLocaleTimeString()}\n`);

  let wsA, wsB;

  // Connect both clients
  try {
    wsA = await connect("Client A");
    wsB = await connect("Client B");
  } catch (e) {
    log(`\n${RED}${BOLD}FATAL: Cannot connect to sync server.${RESET}`);
    log(`${RED}Make sure it's running: node server.js${RESET}\n`);
    process.exit(1);
  }

  await testConnection(wsA, wsB);
  const code = await testRoomCreate(wsA);
  if (code) {
    await testRoomJoin(wsA, wsB, code);
    await testPlay(wsA, wsB);
    await testPause(wsA, wsB);
    await testSeek(wsA, wsB);
    await testSeekNoFeedback(wsA, wsB);
    await testBuffering(wsA, wsB);
    await testBidirectional(wsA, wsB);
  }
  await testReconnection();
  await testPeerDisconnect(wsA, wsB);

  wsA.close();
  wsB.close();

  // ─── Summary ───────────────────────────────────────────────────────────────
  log(`\n${BOLD}================================${RESET}`);
  log(`${BOLD} Results${RESET}`);
  log(`${BOLD}================================${RESET}`);
  log(`  ${GREEN}Passed: ${passed}${RESET}`);
  log(`  ${RED}Failed: ${failed}${RESET}`);
  log(`  Total:  ${passed + failed}`);

  if (failed > 0) {
    log(`\n${RED}${BOLD}Failed tests:${RESET}`);
    results.filter(r => !r.ok).forEach(r => {
      log(`  ${RED}✗ ${r.test}${r.reason ? ` — ${r.reason}` : ""}${RESET}`);
    });
  } else {
    log(`\n${GREEN}${BOLD}All tests passed! Sync server is working correctly.${RESET}`);
  }
  log("");
  process.exit(failed > 0 ? 1 : 0);
}

runTests().catch(e => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
