// Browser proof (WU4): a REAL browser with NO stored token lands straight in
// the conversation when the server trusts the tailnet identity, and still
// lands on the login screen when it doesn't.
//
// Phase 1 (trust ON): the SPA is served through a tiny local proxy that
// injects `Tailscale-User-Login` into every proxied request — HTTP and the
// WebSocket upgrade alike — which is exactly what `tailscale serve` does in
// production. `tailscale serve` itself can't run in a proof, and Playwright
// cannot add a header to a WebSocket handshake, so the proxy IS the
// substitute; the adapter cannot tell the difference (that indistinguishability
// is the documented forgeability caveat, and repro-tailscale-forge-guard.mjs
// is what proves the opt-in gates it). Expected: no login screen at all, the
// status pill reaches "connected", the tailnet login is surfaced in the
// header, a real message round-trips, and no token is ever stored.
//
// Phase 2 (trust OFF, same browser, fresh context): a second harness with the
// opt-in unset, reached DIRECTLY — the tokenless SPA's bare connect gets the
// unchanged 4401 and shows the login screen. And because nothing was wrong
// with any token (there wasn't one), the "invalid token" error copy must NOT
// appear — that message still belongs to a rejected stored token, which the
// final step re-proves by typing the real token in and connecting.
//
// Self-contained: spawns both harnesses, its own proxy, own scratch dirs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pw from '/home/exedev/onecli-browser/node_modules/playwright-core/index.js';
const { chromium } = pw;

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const TRUST_PORT = 7910; // harness with NANOCLAW_WEB_TRUST_TAILSCALE=1
const PROXY_PORT = 7911; // header-injecting proxy in front of it
const PLAIN_PORT = 7912; // harness with the opt-in unset
const TOKEN = 'proof-tailscale-identity-token';
const LOGIN = 'ethan@nanoco.example';
const CHROME = '/home/exedev/.local/bin/chrome';
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-identity-shots-'));

function spawnHarness(port, dataDir, eventLog, trust) {
  const env = {
    ...process.env,
    NANOCLAW_WEB_TOKEN: TOKEN,
    NANOCLAW_WEB_PORT: String(port),
    WEB_HARNESS_DATADIR: dataDir,
  };
  if (trust) env.NANOCLAW_WEB_TRUST_TAILSCALE = '1';
  else delete env.NANOCLAW_WEB_TRUST_TAILSCALE;
  const child = spawn(TSX, [path.join(REPO, 'scripts', 'web-channel-harness.ts'), eventLog], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [harness:${port}] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [harness:${port}:err] ${d}`));
  return child;
}

/**
 * A stand-in for `tailscale serve`: forwards everything to `targetPort` with
 * `Tailscale-User-Login` set. Plain requests go through http.request; the
 * WebSocket upgrade is forwarded at the socket level (rewriting the request
 * line + headers by hand, then piping both directions) because that is the
 * only way to keep the handshake byte-transparent.
 */
function startHeaderProxy({ listenPort, targetPort, login }) {
  const server = http.createServer((req, res) => {
    const proxied = http.request(
      {
        host: '127.0.0.1',
        port: targetPort,
        path: req.url,
        method: req.method,
        headers: { ...req.headers, 'tailscale-user-login': login },
      },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        upstreamRes.pipe(res);
      },
    );
    proxied.on('error', () => {
      try {
        res.writeHead(502);
        res.end('proxy error');
      } catch {
        /* response already gone */
      }
    });
    req.pipe(proxied);
  });

  server.on('upgrade', (req, socket, head) => {
    const upstream = net.connect(targetPort, '127.0.0.1', () => {
      const headers = { ...req.headers, 'tailscale-user-login': login };
      let raw = `${req.method} ${req.url} HTTP/1.1\r\n`;
      for (const [name, value] of Object.entries(headers)) {
        for (const single of Array.isArray(value) ? value : [value]) raw += `${name}: ${single}\r\n`;
      }
      raw += '\r\n';
      upstream.write(raw);
      if (head && head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on('error', () => socket.destroy());
    socket.on('error', () => upstream.destroy());
  });

  return new Promise((resolve) => server.listen(listenPort, '127.0.0.1', () => resolve(server)));
}

async function waitForHealth(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`server never came up at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function waitForStatus(page, status, timeout = 15000) {
  await page.waitForFunction(
    (want) => document.querySelector('[data-testid="connection-status"]')?.textContent?.trim() === want,
    status,
    { timeout },
  );
}

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

async function main() {
  const trustDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-identity-trust-'));
  const plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-identity-plain-'));
  const trustHarness = spawnHarness(TRUST_PORT, trustDir, path.join(trustDir, 'events.jsonl'), true);
  const plainHarness = spawnHarness(PLAIN_PORT, plainDir, path.join(plainDir, 'events.jsonl'), false);
  let proxy = null;
  let browser = null;

  try {
    await waitForHealth(`http://127.0.0.1:${TRUST_PORT}/api/health`);
    await waitForHealth(`http://127.0.0.1:${PLAIN_PORT}/api/health`);
    proxy = await startHeaderProxy({ listenPort: PROXY_PORT, targetPort: TRUST_PORT, login: LOGIN });
    await waitForHealth(`http://127.0.0.1:${PROXY_PORT}/api/health`);
    console.log('OK   trust-ON harness + header-injecting proxy + trust-OFF harness all up');

    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-proxy-server'],
    });

    // ---- Phase 1: trust ON, through the header-injecting proxy ----
    const identityContext = await browser.newContext({ viewport: { width: 960, height: 900 }, deviceScaleFactor: 2 });
    const page = await identityContext.newPage();
    page.on('console', (m) => console.log(`  [browser:${m.type()}] ${m.text()}`));

    // No ?token=, and a brand-new context, so localStorage is genuinely empty
    // — this is a first-ever visit with nothing to authenticate with but the
    // identity the proxy injects.
    await page.goto(`http://127.0.0.1:${PROXY_PORT}/`, { waitUntil: 'domcontentloaded' });
    const preStored = await page.evaluate(() => localStorage.getItem('nanoclaw_web_token'));
    if (preStored !== null) fail(`the fresh context already had a stored token ("${preStored}")`);

    await waitForStatus(page, 'connected');
    console.log('OK   tokenless SPA reached "connected" against the trust-ON server');

    if ((await page.locator('[data-testid="login-input"]').count()) !== 0) {
      fail('the login screen rendered even though the identity connect succeeded');
    }
    console.log('OK   no login screen at any point on the identity path');

    const shown = (await page.locator('[data-testid="user-identity"]').textContent())?.trim();
    if (shown !== LOGIN) fail(`header identity reads "${shown}", expected "${LOGIN}"`);
    console.log(`OK   the tailnet login is surfaced in the header ("${shown}")`);

    // A real round-trip, so "connected" isn't just a pill: type, send, and
    // wait for the harness's markdown answer AND its approval card.
    await page.fill('[data-testid="composer-input"]', 'identity round-trip');
    await page.click('[data-testid="send-button"]');
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[data-testid="message"][data-role="assistant"]')).some((el) =>
          (el.textContent ?? '').includes('deploy summary'),
        ),
      undefined,
      { timeout: 15000 },
    );
    console.log('OK   a real message round-trips over the identity-authenticated socket');
    await page.screenshot({ path: `${SHOTS}/wu4-identity-connected.png`, fullPage: true });

    const postStored = await page.evaluate(() => localStorage.getItem('nanoclaw_web_token'));
    if (postStored !== null) fail(`a token was stored on the identity path ("${postStored}")`);
    console.log('OK   no token was ever stored — the tab is authenticated purely by identity');

    // A reload must land back in the conversation the same way (no login
    // flash, history replayed), since there is still nothing stored.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForStatus(page, 'connected');
    if ((await page.locator('[data-testid="login-input"]').count()) !== 0) {
      fail('a reload of the identity-authenticated tab dropped to the login screen');
    }
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[data-testid="message"][data-role="user"]')).some((el) =>
          (el.textContent ?? '').includes('identity round-trip'),
        ),
      undefined,
      { timeout: 15000 },
    );
    console.log('OK   reload reconnects by identity and replays the conversation (still no login screen)');
    await identityContext.close();

    // ---- Phase 2: trust OFF, straight at the adapter ----
    const plainContext = await browser.newContext({ viewport: { width: 960, height: 900 }, deviceScaleFactor: 2 });
    const plainPage = await plainContext.newPage();
    plainPage.on('console', (m) => console.log(`  [browser:${m.type()}] ${m.text()}`));

    let wsAttempts = 0;
    plainPage.on('websocket', (ws) => {
      if (ws.url().includes('/ws')) wsAttempts += 1;
    });

    await plainPage.goto(`http://127.0.0.1:${PLAIN_PORT}/`, { waitUntil: 'domcontentloaded' });
    await plainPage.waitForSelector('[data-testid="login-input"]', { timeout: 15000 });
    console.log('OK   trust-OFF server: the bare connect is refused and the login screen appears, as today');
    await plainPage.screenshot({ path: `${SHOTS}/wu4-trust-off-login.png`, fullPage: true });

    if ((await plainPage.locator('text=invalid token').count()) !== 0) {
      fail('the "invalid token" error was shown for a connect that never presented a token');
    }
    console.log('OK   no "invalid token" error copy — nothing was wrong with a token, there wasn\'t one');

    // The bare probe must not turn into a retry loop either.
    await plainPage.waitForTimeout(4000);
    if (wsAttempts !== 1) fail(`expected exactly 1 WS attempt on the rejected bare connect, saw ${wsAttempts}`);
    console.log(`OK   exactly one WS attempt (${wsAttempts}) — the rejected probe does not retry`);

    await plainPage.fill('[data-testid="login-input"]', TOKEN);
    await plainPage.click('[data-testid="login-submit"]');
    await waitForStatus(plainPage, 'connected');
    if ((await plainPage.locator('[data-testid="user-identity"]').count()) !== 0) {
      fail('a token-authenticated connection showed an identity in the header');
    }
    console.log('OK   typing the token connects normally, with no identity shown (token auth carries none)');
    await plainPage.screenshot({ path: `${SHOTS}/wu4-trust-off-token-login.png`, fullPage: true });

    console.log(`DONE tailscale-identity browser proof complete (screenshots in ${SHOTS})`);
  } finally {
    if (browser) await browser.close();
    if (proxy) proxy.close();
    trustHarness.kill('SIGTERM');
    plainHarness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
