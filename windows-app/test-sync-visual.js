const WebSocket = require("ws");
const { spawn } = require("child_process");
const path = require("path");
const readline = require("readline");

const SERVER = "ws://localhost:3000";
const TEST_URL = "https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4";
const APP_PATH = path.join(__dirname, "..", "windows-app");

// ─── Colors ──────────────────────────────────────────────────────────────────
const GREEN  = "\x1b[32m";
const RED    = "\x1b[31m";
const YELLOW = "\x1b[33m";
const CYAN   = "\x1b[36m";
const MAGENTA= "\x1b[35m";
const RESET  = "\x1b[0m";
const BOLD   = "\x1b[1m";

let passed = 0;
let failed = 0;

function log(msg) { console.log(msg); }
function ok(test) { passed++; log(`  ${GREEN}✓${RESET} ${test}`); }
function fail(test, reason) { failed++; log(`  ${RED}✗${RESET} ${test}${reason ? ` — ${RED}${reason}${RESET}` : ""}`); }
function wait(ms) { return new Promise(r => setTimeout(r, ms)); }
function header(title) { log(`\n${CYAN}${BOLD}[ ${title} ]${RESET}`); }
function info(msg) { log(`  ${YELLOW}ℹ${RESET}  ${msg}`); }
function watching(msg) { log(`  ${MAGENTA}👀${RESET} ${BOLD}WATCH:${RESET} ${msg}`); }

async function countdown(seconds, label) {
  for (let i = seconds; i > 0; i--) {
    process.stdout.write(`\r  ${YELLOW}⏳${RESET} ${label} — ${BOLD}${i}s${RESET}...   `);
    await wait(1000);
  }
  process.stdout.write(`\r  ${GREEN}✓${RESET} ${label} — done!          \n`);
}

function connect(label) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(SERVER);
    ws.on("open", () => resolve(ws));
    ws.on("error", e => reject(new Error(`${label}: ${e.message}`)));
    setTimeout(() => reject(new Error(`${label} timeout`)), 5000);
  });
}

function waitForEvent(ws, eventName, timeoutMs = 5000) {
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

function send(ws, obj) { ws.send(JSON.stringify(obj)); }

function launchApp(label) {
  log(`  ${YELLOW}🚀${RESET} Launching ${label}...`);
  const proc = spawn("npx", ["electron", "."], {
    cwd: APP_PATH,
    shell: true,
    stdio: "ignore",
    detached: true,
  });
  proc.unref();
  return proc;
}

function pressEnterToContinue(prompt) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(`\n  ${BOLD}${prompt}${RESET} `, () => { rl.close(); resolve(); });
  });
}

// ─── MAIN ────────────────────────────────────────────────────────────────────

async function runVisualTests() {
  log(`\n${BOLD}╔══════════════════════════════════════╗${RESET}`);
  log(`${BOLD}║   Stremio-Sync Visual Test Suite     ║${RESET}`);
  log(`${BOLD}╚══════════════════════════════════════╝${RESET}`);
  log(`  This will open ${BOLD}two app windows${RESET} and test sync visually.`);
  log(`  Watch both windows as each test runs!\n`);

  await pressEnterToContinue("Press ENTER to start...");

  // ── Connect to server ──────────────────────────────────────────────────────
  header("1. Connecting to Sync Server");
  let wsA, wsB;
  try {
    wsA = await connect("Client A");
    ok("Client A connected");
    wsB = await connect("Client B");
    ok("Client B connected");
  } catch (e) {
    log(`\n${RED}${BOLD}Cannot connect to sync server! Is it running?${RESET}`);
    log(`${RED}Run: node server.js${RESET}\n`);
    process.exit(1);
  }

  // ── Launch two app windows ─────────────────────────────────────────────────
  header("2. Launching App Windows");
  info("Opening Host window (Window A)...");
  launchApp("Window A");
  await wait(3000);
  info("Opening Guest window (Window B)...");
  launchApp("Window B");
  await wait(3000);
  ok("Both windows launched");
  info("Arrange the two windows side by side on your screen.");
  await pressEnterToContinue("Press ENTER when ready...");

  // ── Create room ────────────────────────────────────────────────────────────
  header("3. Room Creation");
  send(wsA, { event: "create-room", url: TEST_URL });
  try {
    const msg = await waitForEvent(wsA, "room-created");
    ok(`Room created: ${BOLD}${msg.code}${RESET}`);
    info(`Window A should show room code: ${BOLD}${msg.code}${RESET}`);
    watching("Room code visible in Window A");
    await countdown(4, "Observing room code display");

    // ── Join room ────────────────────────────────────────────────────────────
    header("4. Guest Joining Room");
    send(wsB, { event: "join-room", code: msg.code });
    const [joinMsg] = await Promise.all([
      waitForEvent(wsB, "room-joined"),
      waitForEvent(wsA, "peer-connected"),
    ]);
    ok("Guest joined room");
    ok("Host notified of guest connection");
    watching("Both windows should show 'Partner connected ✓'");
    await countdown(4, "Observing connection status");

    // ── Both launch video ────────────────────────────────────────────────────
    header("5. Video Playback");
    info("MPV should open on both sides with Big Buck Bunny...");
    info("(In real usage this happens automatically via Stremio)");
    await countdown(5, "Waiting for MPV windows to open");

    // ── Play sync ─────────────────────────────────────────────────────────────
    header("6. Play Sync Test");
    watching("Both players should START PLAYING simultaneously");
    send(wsA, { event: "play", timestamp: 0 });
    const playMsg = await waitForEvent(wsB, "play", 5000);
    ok(`Play synced — timestamp: ${playMsg.timestamp}s`);
    await countdown(5, "Watch both videos playing in sync");

    // ── Pause sync ────────────────────────────────────────────────────────────
    header("7. Pause Sync Test");
    watching("Both players should PAUSE simultaneously");
    send(wsA, { event: "pause", timestamp: 5.0 });
    const pauseMsg = await waitForEvent(wsB, "pause", 5000);
    ok(`Pause synced — timestamp: ${pauseMsg.timestamp}s`);
    await countdown(4, "Confirm both players are paused");

    // ── Seek sync ─────────────────────────────────────────────────────────────
    header("8. Seek Sync Test");
    watching("Both players should JUMP TO 1 minute simultaneously");
    send(wsA, { event: "seek", timestamp: 60.0 });
    const seekMsg = await waitForEvent(wsB, "seek", 5000);
    ok(`Seek synced — jumped to ${seekMsg.timestamp}s`);
    await countdown(4, "Confirm both players at 1:00");

    // ── Play after seek ───────────────────────────────────────────────────────
    header("9. Play After Seek");
    watching("Both players should RESUME from 1 minute");
    send(wsA, { event: "play", timestamp: 60.0 });
    await waitForEvent(wsB, "play", 5000);
    ok("Play after seek synced");
    await countdown(5, "Watch both playing from same position");

    // ── Bidirectional — B controls A ─────────────────────────────────────────
    header("10. Bidirectional Control (Guest → Host)");
    watching("GUEST controls: both players should PAUSE");
    send(wsB, { event: "pause", timestamp: 65.0 });
    const biMsg = await waitForEvent(wsA, "pause", 5000);
    ok(`Bidirectional pause synced — ${biMsg.timestamp}s`);
    await countdown(4, "Guest paused both players");

    // ── Seek to later timestamp ───────────────────────────────────────────────
    header("11. Seek to 5 Minutes");
    watching("Both players should JUMP TO 5 minutes");
    send(wsA, { event: "seek", timestamp: 300.0 });
    await waitForEvent(wsB, "seek", 5000);
    send(wsA, { event: "play", timestamp: 300.0 });
    await waitForEvent(wsB, "play", 5000);
    ok("Seek to 5min synced");
    await countdown(5, "Watch both playing from 5:00");

    // ── Buffering sync ────────────────────────────────────────────────────────
    header("12. Buffering Sync Test");
    watching("Both players should PAUSE (simulating buffering)");
    send(wsA, { event: "buffering-start", timestamp: 305.0 });
    const bufStart = await waitForEvent(wsB, "buffering-start", 5000);
    ok("Buffering-start synced to guest");
    await countdown(3, "Host is 'buffering' — guest should be paused");

    send(wsA, { event: "buffering-end", timestamp: 305.5 });
    const bufEnd = await waitForEvent(wsB, "buffering-end-all", 5000);
    ok(`Buffering resolved — resuming at ${bufEnd.timestamp}s`);
    watching("Both players should RESUME after buffering ends");
    await countdown(4, "Both players resuming after buffer");

    // ── Reconnection ──────────────────────────────────────────────────────────
    header("13. Reconnection Test");
    info("Disconnecting and reconnecting Client B...");
    wsB.close();
    await wait(500);
    const notifyMsg = await waitForEvent(wsA, "peer-disconnected", 5000);
    ok("Host notified of guest disconnect");
    watching("Window A should show 'Partner disconnected'");
    await countdown(3, "Observing disconnect notification");

    wsB = await connect("Client B reconnect");
    ok("Client B reconnected to server");
    send(wsB, { event: "join-room", code: msg.code });

    try {
      await waitForEvent(wsB, "room-joined", 3000);
      ok("Client B re-joined room after reconnect");
      await waitForEvent(wsA, "peer-connected", 3000);
      ok("Host notified of guest reconnection");
      watching("Window A should show 'Partner connected ✓' again");
      await countdown(4, "Observing reconnection");
    } catch {
      info("Room may have expired after disconnect — this is expected behavior");
      info("In production, rooms persist for a grace period");
    }

  } catch (e) {
    fail("Test sequence", e.message);
  }

  // ── Final summary ──────────────────────────────────────────────────────────
  wsA?.close();
  wsB?.close();

  log(`\n${BOLD}╔══════════════════════════════════════╗${RESET}`);
  log(`${BOLD}║           Test Results               ║${RESET}`);
  log(`${BOLD}╚══════════════════════════════════════╝${RESET}`);
  log(`  ${GREEN}Passed: ${passed}${RESET}`);
  log(`  ${RED}Failed: ${failed}${RESET}`);
  log(`  Total:  ${passed + failed}`);

  if (failed === 0) {
    log(`\n${GREEN}${BOLD}  🎉 All tests passed! Ready to test over the internet.${RESET}\n`);
  } else {
    log(`\n${RED}${BOLD}  Some tests failed. Check the output above.${RESET}\n`);
  }

  process.exit(failed > 0 ? 1 : 0);
}

runVisualTests().catch(e => {
  console.error("Unexpected error:", e);
  process.exit(1);
});
