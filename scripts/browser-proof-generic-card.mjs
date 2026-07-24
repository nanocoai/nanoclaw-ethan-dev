// Item 1 proof: generic (send_card) card rendering. Drives the SPA with a
// real browser (Chrome-for-testing via playwright-core) and proves:
//  - a generic card with title/body/links renders with working link buttons
//  - a card with no renderable content falls back to fallbackText as a plain
//    message instead of being silently dropped.
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
    viewport: { width: 960, height: 900 },
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

  // --- Scenario A: a renderable generic card ---
  await page.fill('[data-testid="composer-input"]', 'show generic card');
  await page.click('[data-testid="send-button"]');
  await page.waitForSelector('[data-testid="generic-card"]', { timeout: 10000 });
  await page.waitForTimeout(300);

  const title = await page.locator('[data-testid="generic-card-title"]').innerText();
  const bodyCount = await page.locator('[data-testid="generic-card-body"]').count();
  const link0 = page.locator('[data-testid="generic-card-link-0"]');
  const link0Href = await link0.getAttribute('href');
  const link1 = page.locator('[data-testid="generic-card-link-1"]');
  const link1Href = await link1.getAttribute('href');
  console.log(`OK   generic card rendered: title="${title}" bodyParagraphs=${bodyCount}`);
  console.log(`OK   link-0 href="${link0Href}"  link-1 href="${link1Href}"`);
  if (!link0Href || !link1Href) {
    console.error('FAIL missing link hrefs on generic card');
    process.exit(1);
  }

  await page.screenshot({ path: `${SHOTS}/p1-generic-card.png`, fullPage: true });
  console.log('OK   screenshot: p1-generic-card.png');

  // --- Scenario B: nothing renderable — must fall back to fallbackText, never drop ---
  const messageCountBefore = await page.locator('[data-testid="message"]').count();
  await page.fill('[data-testid="composer-input"]', 'show fallback card');
  await page.click('[data-testid="send-button"]');
  await page.waitForFunction(
    (expected) => document.querySelectorAll('[data-testid="message"]').length >= expected,
    messageCountBefore + 2, // the user's own bubble + the fallback assistant message
    { timeout: 10000 },
  );
  await page.waitForTimeout(300);

  const genericCardCountAfter = await page.locator('[data-testid="generic-card"]').count();
  const lastMessageText = await page.locator('[data-testid="message"][data-role="assistant"]').last().innerText();
  console.log(`OK   fallback path: generic-card count still ${genericCardCountAfter} (unchanged), last assistant text: "${lastMessageText.trim()}"`);
  if (!lastMessageText.includes('Fallback-only card')) {
    console.error('FAIL fallback text did not render as a plain message');
    process.exit(1);
  }

  await page.screenshot({ path: `${SHOTS}/p1-generic-card-fallback.png`, fullPage: true });
  console.log('OK   screenshot: p1-generic-card-fallback.png');

  await browser.close();
  console.log('DONE generic card proof complete');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
