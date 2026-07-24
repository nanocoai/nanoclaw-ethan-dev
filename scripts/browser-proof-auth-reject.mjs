// Proof: WS auth-reject surfaces as close 4401, not the opaque 1006 a raw
// HTTP 401 on the upgrade used to produce. Drives the SPA with a real
// browser using a token the running harness will reject, and shows:
//  - the login screen appears (with the "invalid token" error), not an
//    endless "connecting"/backoff spinner
//  - exactly one WS connection attempt is made against the bad token — no
//    reconnect/backoff loop retrying a token that will never work
//  - the stored token is cleared, so a refresh doesn't silently retry it
//  - a real token typed into the login form afterward connects normally
import pw from '/home/exedev/onecli-browser/node_modules/playwright-core/index.js';
const { chromium } = pw;

const PORT = process.env.NANOCLAW_WEB_PORT ?? '7890';
const GOOD_TOKEN = process.env.NANOCLAW_WEB_TOKEN;
const SHOTS = '/home/exedev/nanoco/runbooks/dgx-spark-demo/research/screenshots';
const CHROME = '/home/exedev/.local/bin/chrome';

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

  let wsAttempts = 0;
  page.on('websocket', (ws) => {
    if (ws.url().includes('/ws')) wsAttempts += 1;
  });

  await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent('definitely-the-wrong-token')}`, {
    waitUntil: 'networkidle',
  });

  await page.waitForSelector('[data-testid="login-input"]', { timeout: 10000 });
  console.log('OK   login screen shown after the bad-token 4401 close');

  await page.waitForSelector('text=invalid token', { timeout: 5000 });
  console.log('OK   auth error message rendered');
  await page.screenshot({ path: `${SHOTS}/p2-auth-reject-login.png`, fullPage: true });

  // No-endless-retry: wait well past what several backoff cycles would need
  // if 4401 were (wrongly) being treated as a normal drop, then confirm only
  // the one WS attempt ever happened.
  await page.waitForTimeout(4000);
  if (wsAttempts !== 1) {
    console.error(`FAIL expected exactly 1 WS attempt against the bad token, saw ${wsAttempts} (endless-retry regression)`);
    process.exit(1);
  }
  console.log(`OK   exactly one WS attempt (${wsAttempts}) — no reconnect/backoff loop against a dead token`);

  const stored = await page.evaluate(() => localStorage.getItem('nanoclaw_web_token'));
  if (stored !== null) {
    console.error(`FAIL stored token was not cleared after the 4401 close (still "${stored}")`);
    process.exit(1);
  }
  console.log('OK   stored token cleared after the 4401 close');

  // A real token typed into the login form should still connect normally —
  // this proves the fix only short-circuits the RETRY loop, not logins.
  if (!GOOD_TOKEN) throw new Error('set NANOCLAW_WEB_TOKEN to the running harness token before running this proof');
  await page.fill('[data-testid="login-input"]', GOOD_TOKEN);
  await page.click('[data-testid="login-submit"]');
  await waitForStatus(page, 'connected', 10000);
  console.log('OK   submitting the real token from the login screen connects normally');
  await page.screenshot({ path: `${SHOTS}/p2-auth-reject-recovered.png`, fullPage: true });

  await browser.close();
  console.log('DONE auth-reject (4401) proof complete');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
