// Proof: the client-side heartbeat deadman timer (useNanoclaw.ts,
// HEARTBEAT_DEADMAN_MS) notices a half-open socket and recovers on its own.
//
// The reboot-drill bug this fixes: a server restart can leave a browser tab
// holding a TCP socket that never gets a close event (no FIN/RST reaches the
// tab) — the SPA looks connected and hears nothing until a manual refresh.
// Protocol-level WS pings are invisible to browser JS, so this is
// deliberately NOT tested against web-channel-harness.ts (which behaves
// correctly). Instead this spins up its own minimal "silent" server: it
// completes the WS handshake and sends the initial ready/history frames
// once, like a real connect, then goes completely silent forever — no
// heartbeats, no pings, no close. That silence is exactly what a half-open
// socket looks like from the client's point of view.
//
// Proves: the deadman timer fires (~75s, no shortcuts — this is the real
// production constant), force-closes the dead socket itself, and the
// EXISTING reconnect/backoff machinery (untouched by this fix) opens a fresh
// WS attempt without any user action.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import pw from '/home/exedev/onecli-browser/node_modules/playwright-core/index.js';
const { chromium } = pw;

const here = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.join(here, '..', 'src', 'channels', 'web-ui', 'dist');
const PORT = 7899; // distinct from the real harness's 7890 — fully standalone
const CHROME = '/home/exedev/.local/bin/chrome';
const SHOTS = '/home/exedev/nanoco/runbooks/dgx-spark-demo/research/screenshots';

const CONTENT_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8' };

function serveStatic(req, res) {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const pathname = url.pathname === '/' ? '/index.html' : url.pathname;
  const resolved = path.join(DIST, pathname);
  fs.readFile(resolved, (err, buf) => {
    const target = err ? path.join(DIST, 'index.html') : resolved;
    fs.readFile(target, (e2, body) => {
      if (e2) {
        res.writeHead(404);
        res.end('not built — run npm run build in src/channels/web-ui');
        return;
      }
      const ext = path.extname(target);
      res.writeHead(200, { 'content-type': CONTENT_TYPES[ext] ?? 'application/octet-stream' });
      res.end(body);
    });
  });
}

async function main() {
  const server = http.createServer(serveStatic);
  const wss = new WebSocketServer({ noServer: true });
  let wsUpgradeCount = 0;

  server.on('upgrade', (req, socket, head) => {
    if (!(req.url ?? '').startsWith('/ws')) {
      socket.destroy();
      return;
    }
    wsUpgradeCount += 1;
    const n = wsUpgradeCount;
    console.log(`SILENT-SERVER accepting WS upgrade #${n} — sends the initial state once, then total silence`);
    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.send(JSON.stringify({ type: 'history', frames: [] }));
      ws.send(JSON.stringify({ type: 'ready', threadId: null, typing: false }));
      // Deliberately: no more ws.send(), no ws.on('message'), no ping, no
      // close, ever. This is the half-open-socket scenario verbatim — the
      // handshake + initial state landed, then nothing, forever.
    });
  });

  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  console.log(`SILENT-SERVER listening on ${PORT}`);

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-proxy-server'],
  });
  const context = await browser.newContext({ viewport: { width: 960, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('console', (m) => console.log(`  [browser:${m.type()}] ${m.text()}`));

  try {
    await page.goto(`http://127.0.0.1:${PORT}/?token=irrelevant-the-silent-server-ignores-it`, {
      waitUntil: 'networkidle',
    });

    await page.waitForFunction(
      () => document.querySelector('[data-testid="connection-status"]')?.textContent?.trim() === 'connected',
      { timeout: 10000 },
    );
    console.log('OK   SPA connected (initial ready/history frame delivered, exactly like a real connect)');
    await page.screenshot({ path: `${SHOTS}/p2-deadman-connected.png`, fullPage: true });

    if (wsUpgradeCount !== 1) throw new Error(`expected exactly 1 WS upgrade before silence, saw ${wsUpgradeCount}`);

    console.log('...  server now silent forever. Waiting up to 95s for the client deadman (~75s) to fire and reconnect');
    const deadline = Date.now() + 95000;
    while (wsUpgradeCount < 2 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }

    if (wsUpgradeCount < 2) {
      console.error(
        `FAIL client never force-closed the silent socket — saw only ${wsUpgradeCount} WS upgrade(s) in 95s ` +
          '(the deadman timer did not fire, or the resulting close did not trigger a reconnect)',
      );
      process.exit(1);
    }
    console.log(`OK   deadman fired: client force-closed the silent socket and opened a fresh WS attempt (upgrade #${wsUpgradeCount})`);

    // The reconnect attempt should succeed too (same silent server, but it
    // sends ready/history again on every new upgrade) — confirms this isn't
    // just a close, the EXISTING reconnect machinery actually recovers.
    await page.waitForFunction(
      () => document.querySelector('[data-testid="connection-status"]')?.textContent?.trim() === 'connected',
      { timeout: 10000 },
    );
    console.log('OK   client is connected again after the deadman-triggered reconnect');
    await page.screenshot({ path: `${SHOTS}/p2-deadman-reconnected.png`, fullPage: true });

    await browser.close();
    console.log('DONE client deadman (half-open socket) proof complete');
  } finally {
    server.close();
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
