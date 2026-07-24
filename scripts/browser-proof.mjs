// Real-browser proof: drives the web channel SPA with Chrome-for-testing via
// playwright-core, produces screenshots, and forces a real DOM click on an
// approval button so the harness records onAction. Everything is localhost, so
// the browser bypasses the VM proxy.
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
    viewport: { width: 960, height: 1180 },
    deviceScaleFactor: 2,
  });
  const page = await context.newPage();
  page.on('console', (m) => console.log(`  [browser:${m.type()}] ${m.text()}`));

  await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}`, {
    waitUntil: 'networkidle',
  });

  // Connected?
  await page.waitForFunction(
    () => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('connected'),
    { timeout: 10000 },
  );
  console.log('OK   SPA connected');

  // Send a message.
  await page.fill('[data-testid="composer-input"]', 'deploy the arm64 build to production');
  await page.click('[data-testid="send-button"]');
  console.log('OK   user message sent');

  // Wait for the rendered markdown assistant message and the approval card.
  await page.waitForSelector('[data-testid="assistant-markdown"]', { timeout: 10000 });
  await page.waitForSelector('[data-testid="approval-card"]', { timeout: 10000 });
  // let code-highlight + fonts settle
  await page.waitForTimeout(600);
  console.log('OK   markdown message + approval card rendered');

  await page.screenshot({ path: `${SHOTS}/web-channel-chat.png`, fullPage: true });
  const card = page.locator('[data-testid="approval-card"]').last();
  await card.screenshot({ path: `${SHOTS}/web-channel-card-before.png` });
  console.log('OK   screenshots: chat + card-before');

  // Real DOM click on Approve (option index 0).
  await page.click('[data-testid="option-0"]');
  console.log('OK   clicked Approve (option-0)');

  // Terminal chosen state.
  await page.waitForSelector('[data-testid="card-resolved"]', { timeout: 5000 });
  await page.waitForTimeout(300);
  const resolvedText = await page.locator('[data-testid="card-resolved"]').last().innerText();
  console.log(`OK   card resolved in DOM: "${resolvedText.replace(/\n/g, ' ')}"`);

  await card.screenshot({ path: `${SHOTS}/web-channel-card-after.png` });
  await page.screenshot({ path: `${SHOTS}/web-channel-chat-resolved.png`, fullPage: true });
  console.log('OK   screenshots: card-after + chat-resolved');

  await browser.close();
  console.log('DONE browser proof complete');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
