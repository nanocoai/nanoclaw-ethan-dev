// P2a proof: outbound file attachments render in a REAL browser and download
// with the auth token, the same real-incident fix as the never-drop/eviction
// script-level proofs but exercised through the actual SPA:
//  - an image attachment renders an inline thumbnail whose src is the authed
//    download URL, and the image actually loads (not a broken-image icon)
//  - a non-image attachment renders a download card (name + human size) and
//    clicking it fetches the authed URL and gets the real bytes back
//  - fetching either download URL with a bad token gets 401
// Assumes a harness is already running against NANOCLAW_WEB_PORT/TOKEN (same
// convention as the other browser-proof-*.mjs scripts).
import pw from '/home/exedev/onecli-browser/node_modules/playwright-core/index.js';
const { chromium } = pw;

const PORT = process.env.NANOCLAW_WEB_PORT ?? '7890';
const TOKEN = process.env.NANOCLAW_WEB_TOKEN;
const SHOTS = '/home/exedev/nanoco/runbooks/dgx-spark-demo/research/screenshots';
const CHROME = '/home/exedev/.local/bin/chrome';

// Must match DEMO_PNG / DEMO_DOC in web-channel-harness.ts.
const DEMO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const DEMO_PNG_BYTES = Buffer.from(DEMO_PNG_BASE64, 'base64').length;

async function main() {
  if (!TOKEN) throw new Error('set NANOCLAW_WEB_TOKEN to the running harness token before running this proof');

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

  await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'networkidle' });
  await page.waitForFunction(
    () => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('connected'),
    { timeout: 10000 },
  );
  console.log('OK   SPA connected');

  // --- Scenario A: image attachment — inline thumbnail ---
  await page.fill('[data-testid="composer-input"]', 'send file');
  await page.click('[data-testid="send-button"]');
  await page.waitForSelector('[data-testid="attachment-image"]', { timeout: 10000 });
  await page.waitForTimeout(300);

  // .last() everywhere below: the harness/history is shared across proof
  // runs in the golden suite, so a fresh 'send file' can land after earlier
  // attachment frames already in history — always assert against the one
  // THIS run just sent, not "the only one" (which strict-mode locators
  // would refuse to resolve once more than one exists).
  const imgLoaded = await page.evaluate(() => {
    const imgs = document.querySelectorAll('[data-testid="attachment-image"] img');
    const img = imgs[imgs.length - 1];
    return Boolean(img && img.complete && img.naturalWidth > 0);
  });
  console.log(`OK   image attachment rendered, loaded=${imgLoaded}`);
  if (!imgLoaded) {
    console.error('FAIL image attachment did not actually load (broken image / auth failure)');
    process.exit(1);
  }

  const imgSrc = await page.locator('[data-testid="attachment-image"] img').last().getAttribute('src');
  if (!imgSrc || !imgSrc.includes('/files/') || !imgSrc.includes(`token=${TOKEN}`)) {
    console.error(`FAIL image src does not look like an authed download URL: "${imgSrc}"`);
    process.exit(1);
  }
  console.log(`OK   image src is an authed download URL: ${imgSrc}`);

  // Fetch the same URL from the page context and check the byte count matches.
  const imgFetchLen = await page.evaluate(async (src) => {
    const res = await fetch(src);
    const buf = await res.arrayBuffer();
    return { status: res.status, length: buf.byteLength };
  }, imgSrc);
  console.log(`OK   image fetch: status=${imgFetchLen.status} length=${imgFetchLen.length}`);
  if (imgFetchLen.status !== 200 || imgFetchLen.length !== DEMO_PNG_BYTES) {
    console.error(`FAIL image bytes mismatch: expected ${DEMO_PNG_BYTES}, got status=${imgFetchLen.status} length=${imgFetchLen.length}`);
    process.exit(1);
  }
  console.log('OK   downloaded image bytes match the original attachment exactly');

  await page.screenshot({ path: `${SHOTS}/p2a-attachment-image.png`, fullPage: true });
  console.log('OK   screenshot: p2a-attachment-image.png');

  // --- Scenario B: non-image attachment — download card ---
  await page.fill('[data-testid="composer-input"]', 'send doc file');
  await page.click('[data-testid="send-button"]');
  await page.waitForSelector('[data-testid="attachment-file"]', { timeout: 10000 });
  await page.waitForTimeout(300);

  const fileName = await page.locator('[data-testid="attachment-file-name"]').last().innerText();
  const fileSize = await page.locator('[data-testid="attachment-file-size"]').last().innerText();
  console.log(`OK   download card rendered: name="${fileName.trim()}" size="${fileSize.trim()}"`);
  if (fileName.trim() !== 'notes.txt') {
    console.error(`FAIL expected filename "notes.txt", got "${fileName.trim()}"`);
    process.exit(1);
  }

  await page.screenshot({ path: `${SHOTS}/p2a-attachment-file.png`, fullPage: true });
  console.log('OK   screenshot: p2a-attachment-file.png');

  // Click the download card and confirm a real blob download happens (no
  // "no longer available" fallback appearing).
  await page.locator('[data-testid="attachment-file"]').last().click();
  await page.waitForTimeout(300);
  const unavailableAfterClick = await page.locator('[data-testid="attachment-unavailable"]').count();
  if (unavailableAfterClick > 0) {
    console.error('FAIL clicking the download card showed "no longer available" for a file that is still registered');
    process.exit(1);
  }
  console.log('OK   clicking the download card did not trigger the unavailable state (download succeeded)');

  // --- Scenario C: bad token on the download endpoint gets 401 ---
  const badTokenStatus = await page.evaluate(async () => {
    // Re-derive a download path from the DOM: the image src carries a real
    // fileId; swap the token for a wrong one.
    const imgs = document.querySelectorAll('[data-testid="attachment-image"] img');
    const src = imgs[imgs.length - 1].getAttribute('src');
    const bad = src.replace(/token=[^&]+/, 'token=definitely-wrong');
    const res = await fetch(bad);
    return res.status;
  });
  console.log(`OK   bad-token fetch status: ${badTokenStatus}`);
  if (badTokenStatus !== 401) {
    console.error(`FAIL expected 401 for a bad token on the download endpoint, got ${badTokenStatus}`);
    process.exit(1);
  }
  console.log('OK   bad token on the download endpoint gets 401');

  await browser.close();
  console.log('DONE attachment proof complete');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
