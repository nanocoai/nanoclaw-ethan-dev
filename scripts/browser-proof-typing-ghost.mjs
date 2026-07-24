// Ghost-typing proof: typing dots must never persist forever.
//
// Typing frames are transient by design (web.ts: excluded from `history`
// replay, only broadcast on change to whoever is currently connected). If a
// client is disconnected at the exact moment the server's single
// typing:false clearing frame goes out, that frame is lost forever — the
// client has no other way to learn typing ended, so pre-fix it shows
// animated dots until the heat death of the universe. Live-verified
// 2026-07-24: server idle, no typing broadcasts in flight, browser tab still
// animating dots.
//
// Two independent halves, proved in one browser session:
//
//   PART A — reconnect ready-state fix. Get a real client to MISS the
//   clearing frame (bounce the WS/HTTP layer via SIGUSR2 while typing:true
//   is showing, then release the harness's held turn via SIGUSR1 only once
//   the client is confirmed disconnected — deterministic, not a wall-clock
//   race against the SPA's own reconnect backoff), then reconnect and check
//   the dots are gone immediately, sourced from the `ready` frame's `typing`
//   field rather than a live 'typing' frame that never arrives.
//
//   PART B — client-side auto-expiry. typing:true with NO follow-up ever
//   (never released) must self-clear after ~12s on the SAME still-connected
//   client, with no server frame at all.
//
// Fails on 528cbda2 (PART A: dots never clear post-reconnect). Passes once
// the ready-frame typing field (web.ts) and the SPA timer/ready-adoption
// (useNanoclaw.ts) are both in place.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import pw from '/home/exedev/onecli-browser/node_modules/playwright-core/index.js';
const { chromium } = pw;

const PORT = process.env.NANOCLAW_WEB_PORT ?? '7890';
const TOKEN = process.env.NANOCLAW_WEB_TOKEN;
const DATADIR = process.env.WEB_HARNESS_DATADIR;
const SHOTS = process.env.SHOTS_DIR ?? '/tmp/claude-1000/-home-exedev-nanoco/a1bae43e-61f5-4d91-9335-1515c785749d/scratchpad';
const CHROME = '/home/exedev/.local/bin/chrome';

const TYPING_TIMEOUT_MS = 12000; // must match useNanoclaw.ts's TYPING_TIMEOUT_MS

function harnessPid() {
  return fs.readFileSync(`${DATADIR}/harness.pid`, 'utf8').trim();
}

async function waitForStatus(page, status, timeout = 10000) {
  // EXACT match, not .includes(): 'disconnected' contains 'connected' as a
  // literal substring, so a naive .includes('connected') resolves true even
  // while still disconnected — this bit the first draft of this proof (the
  // reconnect wait fired instantly against a still-disconnected client).
  await page.waitForFunction(
    (want) => document.querySelector('[data-testid="connection-status"]')?.textContent?.trim() === want,
    status,
    { timeout },
  );
}

async function typingVisible(page) {
  return (await page.locator('[data-testid="typing"]').count()) > 0;
}

async function main() {
  fs.mkdirSync(SHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-proxy-server'],
  });
  const context = await browser.newContext({ viewport: { width: 960, height: 900 }, deviceScaleFactor: 2 });
  const page = await context.newPage();
  page.on('console', (m) => console.log(`  [browser:${m.type()}] ${m.text()}`));

  await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'networkidle' });
  await waitForStatus(page, 'connected');
  console.log('OK   SPA connected (first connection)');

  // ---------------------------------------------------------------------
  // PART A — missed clearing frame across a reconnect.
  // ---------------------------------------------------------------------
  await page.fill('[data-testid="composer-input"]', 'ghost typing test');
  await page.click('[data-testid="send-button"]');
  await page.waitForSelector('[data-testid="typing"]', { timeout: 10000 });
  console.log('OK   [A] typing dots visible (server holding the turn open)');
  await page.screenshot({ path: `${SHOTS}/p-ghost-a1-typing-before-drop.png`, fullPage: true });

  const pid = harnessPid();
  console.log(`OK   [A] sending SIGUSR2 to harness pid ${pid} — bounce the WS/HTTP layer`);
  execSync(`kill -USR2 ${pid}`);

  await waitForStatus(page, 'disconnected');
  console.log('OK   [A] client confirmed disconnected');

  // Only now — with the client PROVABLY disconnected — release the harness's
  // held turn. Its typing:false + markdown delivery fires against whatever
  // `clients` set exists at that instant; the reconnected WS/HTTP layer is
  // back up (SIGUSR2's teardown+setup already completed) but this browser's
  // socket has not yet been re-added to it, so the clearing frame reaches
  // nobody — exactly the reported bug's mechanism.
  console.log(`OK   [A] sending SIGUSR1 to harness pid ${pid} — release the held turn`);
  execSync(`kill -USR1 ${pid}`);
  await page.waitForTimeout(400); // let the release's deliver() land server-side
  await page.screenshot({ path: `${SHOTS}/p-ghost-a2-disconnected.png`, fullPage: true });

  await waitForStatus(page, 'connected', 20000);
  console.log('OK   [A] client reconnected');
  await page.waitForTimeout(300);

  const dotsAfterReconnect = await typingVisible(page);
  const markdownCount = await page.locator('[data-testid="assistant-markdown"]').count();
  console.log(`..   [A] after reconnect: typing dots visible=${dotsAfterReconnect}, assistant-markdown count=${markdownCount}`);
  await page.screenshot({ path: `${SHOTS}/p-ghost-a3-after-reconnect.png`, fullPage: true });

  if (markdownCount === 0) {
    console.error('FAIL [A] the completed turn never showed up via history replay — unrelated regression');
    process.exit(1);
  }
  if (dotsAfterReconnect) {
    console.error('FAIL [A] GHOST TYPING: dots are still showing after reconnect even though the server already went quiet');
    process.exit(1);
  }
  console.log('PASS [A] reconnect adopts the server\'s current (false) typing state — no ghost dots');

  // ---------------------------------------------------------------------
  // PART B — client-side ~12s auto-expiry, no server frame ever follows.
  // ---------------------------------------------------------------------
  await page.fill('[data-testid="composer-input"]', 'ghost typing test');
  await page.click('[data-testid="send-button"]');
  await page.waitForSelector('[data-testid="typing"]', { timeout: 10000 });
  console.log('OK   [B] typing dots visible (this turn will NEVER be released — no clearing frame ever arrives)');
  await page.screenshot({ path: `${SHOTS}/p-ghost-b1-typing-visible.png`, fullPage: true });

  // Sanity: dots must still be showing well before the timeout (proves this
  // isn't a coincidental early clear).
  await page.waitForTimeout(TYPING_TIMEOUT_MS - 4000);
  const stillVisibleBeforeTimeout = await typingVisible(page);
  console.log(`..   [B] ~${(TYPING_TIMEOUT_MS - 4000) / 1000}s in: typing dots visible=${stillVisibleBeforeTimeout}`);
  if (!stillVisibleBeforeTimeout) {
    console.error('FAIL [B] dots cleared too early — timer duration or trigger is wrong');
    process.exit(1);
  }

  await page.waitForTimeout(4000 + 1000); // cross the ~12s mark with margin
  const dotsAfterTimeout = await typingVisible(page);
  console.log(`..   [B] after ~${TYPING_TIMEOUT_MS / 1000 + 1}s total: typing dots visible=${dotsAfterTimeout}`);
  await page.screenshot({ path: `${SHOTS}/p-ghost-b2-after-timeout.png`, fullPage: true });

  if (dotsAfterTimeout) {
    console.error('FAIL [B] GHOST TYPING: dots never auto-expired despite no server frame ever following typing:true');
    process.exit(1);
  }
  console.log('PASS [B] typing indicator auto-expired client-side with no server frame');

  // Release the still-pending PART B turn so the harness process doesn't
  // carry a dangling promise (harmless either way, just tidy).
  execSync(`kill -USR1 ${pid}`);

  await browser.close();
  console.log('DONE ghost-typing proof complete — both halves pass');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
