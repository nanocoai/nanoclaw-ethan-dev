// Item 3 proof: WS reconnect + server-side history replay. Drives the SPA
// with a real browser, builds up some conversation state, then bounces the
// harness's WS/HTTP layer (SIGUSR2 — teardown()+setup() on the SAME adapter
// instance, so in-memory history survives even though every socket drops).
// Proves the client's exponential-backoff reconnect fires and the SPA
// rebuilds the full conversation from the replayed history rather than
// coming back blank.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import pw from '/home/exedev/onecli-browser/node_modules/playwright-core/index.js';
const { chromium } = pw;

const PORT = process.env.NANOCLAW_WEB_PORT ?? '7890';
const TOKEN = process.env.NANOCLAW_WEB_TOKEN;
const DATADIR = process.env.WEB_HARNESS_DATADIR;
const SHOTS = '/home/exedev/nanoco/runbooks/dgx-spark-demo/research/screenshots';
const CHROME = '/home/exedev/.local/bin/chrome';

function harnessPid() {
  return fs.readFileSync(`${DATADIR}/harness.pid`, 'utf8').trim();
}

// EXACT match, not .includes(): 'disconnected' contains 'connected' as a
// literal substring, so a naive .includes('connected') resolves true even
// while still disconnected — the same latent false positive documented in
// browser-proof-typing-ghost.mjs's waitForStatus helper, copied here.
async function waitForStatus(page, status, timeout = 10000) {
  await page.waitForFunction(
    (want) => document.querySelector('[data-testid="connection-status"]')?.textContent?.trim() === want,
    status,
    { timeout },
  );
}

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-proxy-server'],
  });
  const context = await browser.newContext({
    viewport: { width: 960, height: 900 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on('console', (m) => console.log(`  [browser:${m.type()}] ${m.text()}`));

  await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}`, {
    waitUntil: 'networkidle',
  });
  await waitForStatus(page, 'connected', 10000);
  console.log('OK   SPA connected (first connection)');

  // Build up some state: a generic card and a plain markdown/approval exchange.
  await page.fill('[data-testid="composer-input"]', 'show generic card');
  await page.click('[data-testid="send-button"]');
  await page.waitForSelector('[data-testid="generic-card"]', { timeout: 10000 });

  await page.fill('[data-testid="composer-input"]', 'deploy the arm64 build to production');
  await page.click('[data-testid="send-button"]');
  await page.waitForSelector('[data-testid="approval-card"]', { timeout: 10000 });
  await page.waitForTimeout(300);

  const messageCountBefore = await page.locator('[data-testid="message"]').count();
  const cardCountBefore = await page.locator('[data-testid="approval-card"], [data-testid="generic-card"]').count();
  console.log(`OK   built up state: ${messageCountBefore} messages, ${cardCountBefore} cards`);
  await page.screenshot({ path: `${SHOTS}/p1-reconnect-before.png`, fullPage: true });

  // Bounce the WS/HTTP layer on the harness process — NOT a whole process
  // restart, just teardown()+setup() on the same adapter instance.
  const pid = harnessPid();
  console.log(`OK   sending SIGUSR2 to harness pid ${pid} to bounce the WS server`);
  execSync(`kill -USR2 ${pid}`);

  // The client should notice the drop (status flips off 'connected') and
  // then, after its backoff, come back.
  await waitForStatus(page, 'disconnected', 10000);
  console.log('OK   client detected the drop (status: disconnected)');
  await page.screenshot({ path: `${SHOTS}/p1-reconnect-disconnected.png`, fullPage: true });

  await waitForStatus(page, 'connected', 20000);
  console.log('OK   client reconnected (status: connected)');
  await page.waitForTimeout(300);

  const messageCountAfter = await page.locator('[data-testid="message"]').count();
  const cardCountAfter = await page.locator('[data-testid="approval-card"], [data-testid="generic-card"]').count();
  console.log(`OK   after reconnect: ${messageCountAfter} messages (was ${messageCountBefore}), ${cardCountAfter} cards (was ${cardCountBefore})`);

  if (messageCountAfter < messageCountBefore || cardCountAfter < cardCountBefore) {
    console.error('FAIL history did not fully replay after reconnect');
    process.exit(1);
  }

  // The conversation should still be usable post-reconnect.
  await page.fill('[data-testid="composer-input"]', 'ship it');
  await page.click('[data-testid="send-button"]');
  await page.waitForSelector('[data-testid="assistant-markdown"]', { timeout: 10000 });
  console.log('OK   conversation still live after reconnect (new message delivered)');

  await page.screenshot({ path: `${SHOTS}/p1-reconnect-history.png`, fullPage: true });
  console.log('OK   screenshot: p1-reconnect-history.png');

  await browser.close();
  console.log('DONE reconnect + history proof complete');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
