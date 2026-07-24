// Item 2 proof: message editing (deliver() operation:'edit'). Drives the SPA
// with a real browser and proves:
//  - an edit targeting a message the adapter delivered updates it in place
//    (same DOM position, new text, old text gone)
//  - an edit targeting an unknown id is appended rather than dropped
import pw from '/home/exedev/onecli-browser/node_modules/playwright-core/index.js';
const { chromium } = pw;

const PORT = process.env.NANOCLAW_WEB_PORT ?? '7890';
const TOKEN = process.env.NANOCLAW_WEB_TOKEN;
const SHOTS = '/home/exedev/nanoco/runbooks/dgx-spark-demo/research/screenshots';
const CHROME = '/home/exedev/.local/bin/chrome';

async function main() {
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-proxy-server'],
  });
  const context = await browser.newContext({
    viewport: { width: 960, height: 700 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on('console', (m) => console.log(`  [browser:${m.type()}] ${m.text()}`));

  await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('connected'),
    { timeout: 10000 },
  );
  console.log('OK   SPA connected');

  // --- Edit in place ---
  await page.fill('[data-testid="composer-input"]', 'edit test');
  await page.click('[data-testid="send-button"]');
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('[data-testid="message"][data-role="assistant"]')).some((el) =>
      el.textContent?.includes('Original message'),
    ),
    { timeout: 10000 },
  );
  await page.waitForTimeout(150);

  const assistantMessagesBefore = await page.locator('[data-testid="message"][data-role="assistant"]').count();
  await page.screenshot({ path: `${SHOTS}/p1-edit-before.png`, fullPage: true });
  console.log(`OK   original message rendered (${assistantMessagesBefore} assistant messages) — screenshot p1-edit-before.png`);

  // Wait for the edit to land (the harness sends it ~300ms after the original).
  await page.waitForFunction(
    () => Array.from(document.querySelectorAll('[data-testid="message"][data-role="assistant"]')).some((el) =>
      el.textContent?.includes('Edited in place'),
    ),
    { timeout: 10000 },
  );
  await page.waitForTimeout(150);

  const assistantMessagesAfter = await page.locator('[data-testid="message"][data-role="assistant"]').count();
  const stillHasOriginal = await page.locator('[data-testid="message"][data-role="assistant"]', {
    hasText: 'Original message',
  }).count();
  console.log(`OK   after edit: ${assistantMessagesAfter} assistant messages (was ${assistantMessagesBefore}), original text present: ${stillHasOriginal > 0}`);
  if (assistantMessagesAfter !== assistantMessagesBefore) {
    console.error('FAIL edit changed the message count — expected an in-place update, not an append');
    process.exit(1);
  }
  if (stillHasOriginal > 0) {
    console.error('FAIL original text is still visible after the edit');
    process.exit(1);
  }

  await page.screenshot({ path: `${SHOTS}/p1-edit-after.png`, fullPage: true });
  console.log('OK   screenshot: p1-edit-after.png');

  // --- Edit for an unknown id — must append, never drop ---
  const countBeforeUnknown = await page.locator('[data-testid="message"]').count();
  await page.fill('[data-testid="composer-input"]', 'edit unknown');
  await page.click('[data-testid="send-button"]');
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-testid="message"]').length >= expected,
    countBeforeUnknown + 2, // the user's own bubble + the appended edit
    { timeout: 10000 },
  );
  await page.waitForTimeout(150);

  const lastText = await page.locator('[data-testid="message"][data-role="assistant"]').last().innerText();
  console.log(`OK   edit for unknown id appended: "${lastText.trim()}"`);
  if (!lastText.includes('nobody has seen')) {
    console.error('FAIL edit-for-unknown-id was not appended');
    process.exit(1);
  }

  await page.screenshot({ path: `${SHOTS}/p1-edit-unknown-appended.png`, fullPage: true });
  console.log('OK   screenshot: p1-edit-unknown-appended.png');

  await browser.close();
  console.log('DONE edit proof complete');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
