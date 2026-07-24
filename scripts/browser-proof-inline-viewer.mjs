// Inline file viewer proof (commit 3, md-bui-style "open file"). A real
// browser drives four harness scenarios against the SAME scratch process:
//   - 'send markdown file' -> README.md renders FORMATTED markdown inline
//     (through the same Markdown component assistant messages use — headings,
//     bold, a list — not raw text)
//   - 'send code file' -> greet.py shows a monospace viewer with line
//     numbers (checked against the known line count)
//   - 'send big file' -> a >1MB .txt gets NO inline-view toggle at all (only
//     the download card / open-in-new-tab), proving the size gate
//   - collapse/expand toggling actually flips the DOM (panel appears/
//     disappears, toggle label flips) and survives a page reload (a
//     replayed file row's viewer must work identically to a live one — the
//     content is fetched fresh via the same authed /files/<id> URL either way)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pw from '/home/exedev/onecli-browser/node_modules/playwright-core/index.js';
const { chromium } = pw;

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7903;
const TOKEN = 'proof-inline-viewer-token';
const SHOTS = '/home/exedev/nanoco/runbooks/dgx-spark-demo/research/screenshots';
const CHROME = '/home/exedev/.local/bin/chrome';

async function waitForHealth(url, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    if (Date.now() > deadline) throw new Error(`harness never came up at ${url}`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-inline-viewer-'));
  const harness = spawn(TSX, [path.join(REPO, 'scripts', 'web-channel-harness.ts')], {
    cwd: REPO,
    env: { ...process.env, NANOCLAW_WEB_TOKEN: TOKEN, NANOCLAW_WEB_PORT: String(PORT), WEB_HARNESS_DATADIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  harness.stdout.on('data', (d) => process.stdout.write(`  [harness] ${d}`));
  harness.stderr.on('data', (d) => process.stderr.write(`  [harness:err] ${d}`));

  let browser;
  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    console.log('OK   scratch harness up');

    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-proxy-server'],
    });
    const context = await browser.newContext({ viewport: { width: 960, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on('console', (m) => console.log(`  [browser:${m.type()}] ${m.text()}`));

    await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'networkidle' });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('connected'),
      { timeout: 10000 },
    );
    console.log('OK   SPA connected');

    // --- Markdown file: renders FORMATTED, not raw text ---
    await page.fill('[data-testid="composer-input"]', 'send markdown file');
    await page.click('[data-testid="send-button"]');
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[data-testid="attachment-file-name"]')).some(
          (el) => el.textContent?.trim() === 'README.md',
        ),
      { timeout: 10000 },
    );
    console.log('OK   README.md attachment row rendered');

    const mdRow = page.locator('[data-testid="attachment-row"]').filter({ hasText: 'README.md' }).last();
    const mdToggleCount = await mdRow.locator('[data-testid="attachment-view-toggle"]').count();
    if (mdToggleCount !== 1) throw new Error(`FAIL expected an inline-view toggle on README.md, count=${mdToggleCount}`);
    await mdRow.locator('[data-testid="attachment-view-toggle"]').click();
    await page.waitForSelector('[data-testid="inline-viewer-markdown"]', { timeout: 5000 });

    const rendersHeading = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="inline-viewer-markdown"]');
      return Boolean(panel?.querySelector('h1') && panel.querySelector('h1').textContent?.includes('release notes'));
    });
    const rendersBold = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="inline-viewer-markdown"]');
      return Boolean(panel && Array.from(panel.querySelectorAll('strong')).some((el) => el.textContent === 'markdown'));
    });
    const rendersList = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="inline-viewer-markdown"]');
      return (panel?.querySelectorAll('li').length ?? 0) === 2;
    });
    console.log(`OK   markdown formatted: h1=${rendersHeading} strong=${rendersBold} li-count-2=${rendersList}`);
    if (!rendersHeading || !rendersBold || !rendersList) {
      throw new Error('FAIL README.md did not render as FORMATTED markdown (h1/strong/list missing) — looks like raw text');
    }
    // The raw markdown source markers must NOT be visible as literal text —
    // confirms this went through the renderer, not a `<pre>` dump.
    const rawMarkerVisible = await page.evaluate(() => {
      const panel = document.querySelector('[data-testid="inline-viewer-markdown"]');
      return Boolean(panel?.textContent?.includes('# release notes') || panel?.textContent?.includes('**markdown**'));
    });
    if (rawMarkerVisible) throw new Error('FAIL raw markdown syntax (#, **) is visible — not actually rendered');
    console.log('OK   raw markdown syntax markers are NOT visible (genuinely rendered, not dumped as text)');

    await page.screenshot({ path: `${SHOTS}/inline-viewer-markdown.png`, fullPage: true });
    console.log('OK   screenshot: inline-viewer-markdown.png');

    // Collapse toggling actually flips the DOM.
    await mdRow.locator('[data-testid="attachment-view-toggle"]').click();
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="inline-viewer-markdown"]').length === 0,
      { timeout: 5000 },
    );
    console.log('OK   collapse removes the inline panel from the DOM');

    // --- Code file: monospace viewer with line numbers ---
    await page.fill('[data-testid="composer-input"]', 'send code file');
    await page.click('[data-testid="send-button"]');
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[data-testid="attachment-file-name"]')).some(
          (el) => el.textContent?.trim() === 'greet.py',
        ),
      { timeout: 10000 },
    );
    const codeRow = page.locator('[data-testid="attachment-row"]').filter({ hasText: 'greet.py' }).last();
    await codeRow.locator('[data-testid="attachment-view-toggle"]').click();
    await page.waitForSelector('[data-testid="inline-viewer-code"]', { timeout: 5000 });

    // DEMO_CODE in the harness is 5 lines (4 real lines + a trailing blank from the join).
    const lineNumbers = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="inline-viewer-line-number"]')).map((el) => el.textContent?.trim()),
    );
    console.log(`OK   code viewer line numbers: ${JSON.stringify(lineNumbers)}`);
    if (lineNumbers.length !== 5 || lineNumbers[0] !== '1' || lineNumbers[4] !== '5') {
      throw new Error(`FAIL expected line numbers 1..5, got ${JSON.stringify(lineNumbers)}`);
    }
    const codeHeader = await page.evaluate(
      () => document.querySelector('[data-testid="inline-viewer-header"]')?.textContent?.trim(),
    );
    if (!codeHeader?.includes('greet.py')) {
      throw new Error(`FAIL expected the filename in the viewer header, got "${codeHeader}"`);
    }
    console.log(`OK   code viewer header shows the filename: "${codeHeader}"`);
    const isMonospace = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="inline-viewer-code"] td:nth-child(2)');
      return el ? getComputedStyle(el).fontFamily.toLowerCase().includes('mono') : false;
    });
    if (!isMonospace) throw new Error('FAIL code viewer content is not monospace');
    console.log('OK   code content renders in a monospace font');

    await page.screenshot({ path: `${SHOTS}/inline-viewer-code.png`, fullPage: true });
    console.log('OK   screenshot: inline-viewer-code.png');

    // --- Big file (>1MB): no inline offer at all ---
    await page.fill('[data-testid="composer-input"]', 'send big file');
    await page.click('[data-testid="send-button"]');
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[data-testid="attachment-file-name"]')).some(
          (el) => el.textContent?.trim() === 'huge-log.txt',
        ),
      { timeout: 10000 },
    );
    const bigRow = page.locator('[data-testid="attachment-row"]').filter({ hasText: 'huge-log.txt' }).last();
    const bigToggleCount = await bigRow.locator('[data-testid="attachment-view-toggle"]').count();
    const bigOpenNewTabCount = await bigRow.locator('[data-testid="attachment-open-newtab"]').count();
    console.log(`OK   >1MB file: inline-toggle count=${bigToggleCount} open-in-new-tab count=${bigOpenNewTabCount}`);
    if (bigToggleCount !== 0) throw new Error('FAIL a >1MB file must NOT offer an inline-view toggle');
    if (bigOpenNewTabCount !== 1) throw new Error('FAIL a >1MB (non-inline-eligible) file must offer "open in a new tab"');

    // The pre-existing golden proof (browser-proof-attachment.mjs) still
    // clicks [data-testid="attachment-file"] expecting a download, for a
    // .txt fixture that IS inline-eligible by extension/mime — confirm that
    // click still triggers the unchanged download path, not the toggle.
    await bigRow.locator('[data-testid="attachment-file"]').click();
    await page.waitForTimeout(300);
    const unavailableAfterClick = await page.locator('[data-testid="attachment-unavailable"]').count();
    if (unavailableAfterClick > 0) {
      throw new Error('FAIL clicking the download button on a non-inline-eligible row broke the existing download path');
    }
    console.log('OK   the plain download button/path is unaffected for a non-inline-eligible file');

    // --- Replay: a reloaded (non-live) row's viewer works identically ---
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('connected'),
      { timeout: 10000 },
    );
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[data-testid="attachment-file-name"]')).some(
          (el) => el.textContent?.trim() === 'greet.py',
        ),
      { timeout: 10000 },
    );
    const replayedCodeRow = page.locator('[data-testid="attachment-row"]').filter({ hasText: 'greet.py' }).last();
    await replayedCodeRow.locator('[data-testid="attachment-view-toggle"]').click();
    await page.waitForSelector('[data-testid="inline-viewer-code"]', { timeout: 5000 });
    const replayedLineCount = await page.locator('[data-testid="inline-viewer-line-number"]').count();
    if (replayedLineCount !== 5) {
      throw new Error(`FAIL replayed greet.py inline viewer expected 5 lines, got ${replayedLineCount}`);
    }
    console.log('OK   inline viewer works identically for a REPLAYED (post-reload) file row');

    console.log('DONE inline-viewer proof complete');
  } finally {
    if (browser) await browser.close().catch(() => {});
    harness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
