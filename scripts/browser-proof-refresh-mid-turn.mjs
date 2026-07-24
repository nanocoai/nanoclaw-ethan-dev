// P1a proof: the literal reported bug. A real browser sends a message, sees
// the typing dots animate, does a hard `page.reload()` mid-turn (exactly
// like hitting refresh on a phone while the agent is composing), and the
// assistant's eventual answer must (a) show up live once reconnected, and
// (b) still be there after a SECOND reload's history replay.
//
// Requires the harness running with a stretched turn window so the reload
// cycle reliably lands mid-turn:
//   HARNESS_TYPING_DELAY_MS=3000 HARNESS_CARD_DELAY_MS=500
import fs from 'node:fs';
import pw from '/home/exedev/onecli-browser/node_modules/playwright-core/index.js';
const { chromium } = pw;

const PORT = process.env.NANOCLAW_WEB_PORT ?? '7890';
const TOKEN = process.env.NANOCLAW_WEB_TOKEN;
const SHOTS = process.env.SHOTS_DIR ?? '/tmp/claude-1000/-home-exedev-nanoco/a1bae43e-61f5-4d91-9335-1515c785749d/scratchpad';
const CHROME = '/home/exedev/.local/bin/chrome';

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

  const url = `http://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}`;
  await page.goto(url, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('connected'),
    { timeout: 10000 },
  );
  console.log('OK   SPA connected (first load)');

  // Trigger the default markdown+card turn.
  await page.fill('[data-testid="composer-input"]', 'ship it');
  await page.click('[data-testid="send-button"]');

  // Wait for the typing dots to animate — this IS the "mid-turn" moment.
  await page.waitForSelector('[data-testid="typing"]', { timeout: 10000 });
  console.log('OK   typing dots visible — agent is mid-turn, refreshing NOW');
  await page.screenshot({ path: `${SHOTS}/p1a-1-typing-before-refresh.png`, fullPage: true });

  // THE REPRO: hard refresh while mid-turn.
  await page.reload({ waitUntil: 'networkidle' });
  console.log('OK   page reloaded (hard refresh, exactly like the field report)');

  await page.waitForFunction(
    () => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('connected'),
    { timeout: 15000 },
  );
  console.log('OK   reconnected after reload');

  // Give the still-in-flight turn time to finish landing (markdown, then card).
  await page.waitForSelector('[data-testid="assistant-markdown"]', { timeout: 15000 }).catch(() => null);
  await page.waitForSelector('[data-testid="approval-card"]', { timeout: 15000 }).catch(() => null);
  await page.waitForTimeout(300);

  const liveMarkdownCount = await page.locator('[data-testid="assistant-markdown"]').count();
  const liveCardCount = await page.locator('[data-testid="approval-card"]').count();
  console.log(`..   after reconnect (live): markdown=${liveMarkdownCount} card=${liveCardCount}`);
  await page.screenshot({ path: `${SHOTS}/p1a-2-after-reconnect-live.png`, fullPage: true });

  // THE ACTUAL BUG CHECK: reload AGAIN, well after the turn is fully done, and
  // confirm history replay (not a live frame) still carries the answer.
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('connected'),
    { timeout: 15000 },
  );
  await page.waitForTimeout(300);

  const replayMarkdownCount = await page.locator('[data-testid="assistant-markdown"]').count();
  const replayCardCount = await page.locator('[data-testid="approval-card"]').count();
  console.log(`..   after SECOND reload (history replay): markdown=${replayMarkdownCount} card=${replayCardCount}`);
  await page.screenshot({ path: `${SHOTS}/p1a-3-history-replay-after-second-reload.png`, fullPage: true });

  await browser.close();

  if (liveMarkdownCount === 0 || liveCardCount === 0) {
    console.error('FAIL: the agent turn in flight during the refresh never arrived live after reconnect');
    process.exit(1);
  }
  if (replayMarkdownCount === 0 || replayCardCount === 0) {
    console.error('FAIL: history replay after a second reload does NOT include the mid-turn answer — THE REPORTED BUG');
    process.exit(1);
  }

  console.log('PASS: mid-turn refresh — live delivery AND history replay both include the answer');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
