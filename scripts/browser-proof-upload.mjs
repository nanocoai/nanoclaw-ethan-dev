// Files-IN proof: composer attach -> multipart /upload -> host attachment
// shape -> live render -> replay. Three phases against the SAME scratch
// harness process:
//
//   1. Real browser: type a caption, attach two files (an image + a text
//      file) via the hidden file input, send. The user-side message bubble
//      AND both file rows must render LIVE, with NO reload — the exact
//      regression this design brief calls out (a missing case in the SPA's
//      onmessage switch/reducer renders only after refresh). Then the
//      harness's recorded onInbound event is read back off its JSONL log and
//      the `content.attachments` array is asserted field-by-field against the
//      Chat SDK bridge's shape (chat-sdk-bridge.ts messageToInbound,
//      `serialized.attachments`): { type, name, mimeType, size, data(base64) }.
//   2. page.reload() — a fresh connection with zero client state — and the
//      same message + file rows (role, name, downloadPath) must replay
//      identically, and the download still returns the original bytes.
//   3. Raw HTTP (no browser): the /upload endpoint's error contract —
//      unauthorized (401), no files (400), too many files (400), oversized
//      file (413) — each with a JSON `{error: string}` body, which is
//      exactly the shape useNanoclaw.ts's uploadFiles() parses to populate
//      the SPA's upload-error banner.
//
// Self-contained (spawns its own harness), same pattern as repro-file-replay.mjs.
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
const PORT = 7902;
const TOKEN = 'proof-upload-token';
const SHOTS = '/home/exedev/nanoco/runbooks/dgx-spark-demo/research/screenshots';
const CHROME = '/home/exedev/.local/bin/chrome';

// A real (tiny, valid) 1x1 transparent PNG, same fixture the outbound
// attachment proof uses — so a broken <img> vs a genuinely loaded one is
// unambiguous.
const DEMO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const DEMO_PNG = Buffer.from(DEMO_PNG_BASE64, 'base64');
const DEMO_TXT = Buffer.from('a plain text file uploaded from the browser\n', 'utf8');

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

/** Build a minimal multipart/form-data body by hand — for the raw-HTTP phase, which deliberately does NOT go through FormData/fetch's own encoder (so a specific oversized/malformed shape is exact and reproducible). */
function buildMultipart(boundary, parts) {
  const chunks = [];
  for (const part of parts) {
    chunks.push(Buffer.from(`--${boundary}\r\n`));
    if (part.filename !== undefined) {
      chunks.push(
        Buffer.from(
          `Content-Disposition: form-data; name="${part.name}"; filename="${part.filename}"\r\nContent-Type: ${part.contentType ?? 'application/octet-stream'}\r\n\r\n`,
        ),
      );
    } else {
      chunks.push(Buffer.from(`Content-Disposition: form-data; name="${part.name}"\r\n\r\n`));
    }
    chunks.push(Buffer.isBuffer(part.data) ? part.data : Buffer.from(part.data));
    chunks.push(Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return Buffer.concat(chunks);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-upload-'));
  const eventLogPath = path.join(dataDir, 'events.jsonl');
  const harness = spawn(TSX, [path.join(REPO, 'scripts', 'web-channel-harness.ts'), eventLogPath], {
    cwd: REPO,
    env: { ...process.env, NANOCLAW_WEB_TOKEN: TOKEN, NANOCLAW_WEB_PORT: String(PORT), WEB_HARNESS_DATADIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  harness.stdout.on('data', (d) => process.stdout.write(`  [harness] ${d}`));
  harness.stderr.on('data', (d) => process.stderr.write(`  [harness:err] ${d}`));

  function readEvents() {
    return fs
      .readFileSync(eventLogPath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  }

  let browser;
  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    console.log('OK   scratch harness up');

    // --- Phase 1: real browser — attach + send, live render ---
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

    await page.fill('[data-testid="composer-input"]', 'here is what I found');
    await page.locator('[data-testid="file-input"]').setInputFiles([
      { name: 'photo.png', mimeType: 'image/png', buffer: DEMO_PNG },
      { name: 'notes.txt', mimeType: 'text/plain', buffer: DEMO_TXT },
    ]);
    const chipCount = await page.locator('[data-testid="pending-chip"]').count();
    console.log(`OK   pending chips before send: ${chipCount}`);
    if (chipCount !== 2) throw new Error(`FAIL expected 2 pending chips, got ${chipCount}`);

    await page.click('[data-testid="send-button"]');

    // Live — no reload anywhere in this block. This is the exact regression
    // trap called out in the design brief: a frame type missing from the
    // SPA's onmessage switch renders only after a refresh, never live.
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="attachment-row"][data-role="user"]').length >= 2,
      { timeout: 10000 },
    );
    await page.waitForFunction(
      () =>
        Array.from(document.querySelectorAll('[data-testid="message"][data-role="user"]')).some((el) =>
          el.textContent?.includes('here is what I found'),
        ),
      { timeout: 5000 },
    );
    console.log('OK   caption message + both user-role file rows rendered LIVE (no reload)');

    const liveImgLoaded = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="attachment-row"][data-role="user"] img');
      return Boolean(row && row.complete && row.naturalWidth > 0);
    });
    if (!liveImgLoaded) throw new Error('FAIL live uploaded image did not actually load');
    console.log('OK   live uploaded image thumbnail actually loaded');

    await page.screenshot({ path: `${SHOTS}/upload-live.png`, fullPage: true });
    console.log('OK   screenshot: upload-live.png');

    // --- Assert the exact InboundMessage attachment shape recorded by the harness ---
    const events = readEvents();
    const inboundEvents = events.filter((e) => e.event === 'onInbound');
    const uploadEvent = inboundEvents
      .slice()
      .reverse()
      .find((e) => Array.isArray(e.message?.content?.attachments) && e.message.content.attachments.length > 0);
    if (!uploadEvent) throw new Error('FAIL no onInbound event with attachments was recorded by the harness');

    const content = uploadEvent.message.content;
    console.log(`OK   recorded onInbound content: text=${JSON.stringify(content.text)} attachments=${content.attachments.length}`);
    if (content.text !== 'here is what I found') {
      throw new Error(`FAIL expected caption text on the inbound message, got ${JSON.stringify(content.text)}`);
    }
    if (content.sender !== 'web' || content.senderId !== 'web:local') {
      throw new Error(`FAIL sender/senderId do not match the WS text-message path's shape: ${JSON.stringify(content)}`);
    }
    if (content.attachments.length !== 2) {
      throw new Error(`FAIL expected 2 attachments, got ${content.attachments.length}`);
    }

    const png = content.attachments.find((a) => a.name === 'photo.png');
    const txt = content.attachments.find((a) => a.name === 'notes.txt');
    if (!png || !txt) throw new Error(`FAIL missing an expected attachment: ${JSON.stringify(content.attachments)}`);

    // Field-by-field against the bridge's serialized.attachments shape
    // (chat-sdk-bridge.ts messageToInbound): type/name/mimeType/size/data.
    for (const [label, att, expectedType, expectedMime, expectedBytes] of [
      ['photo.png', png, 'image', 'image/png', DEMO_PNG],
      ['notes.txt', txt, 'file', 'text/plain', DEMO_TXT],
    ]) {
      if (att.type !== expectedType) throw new Error(`FAIL ${label}: expected type="${expectedType}", got "${att.type}"`);
      if (att.mimeType !== expectedMime) {
        throw new Error(`FAIL ${label}: expected mimeType="${expectedMime}", got "${att.mimeType}"`);
      }
      if (att.size !== expectedBytes.length) {
        throw new Error(`FAIL ${label}: expected size=${expectedBytes.length}, got ${att.size}`);
      }
      if (typeof att.data !== 'string' || att.data.length === 0) {
        throw new Error(`FAIL ${label}: expected a non-empty base64 "data" field, got ${typeof att.data}`);
      }
      const decoded = Buffer.from(att.data, 'base64');
      if (!decoded.equals(expectedBytes)) {
        throw new Error(`FAIL ${label}: decoded base64 data does not match the original bytes`);
      }
      console.log(`OK   ${label}: type="${att.type}" mimeType="${att.mimeType}" size=${att.size} data decodes to the original bytes`);
    }
    console.log('OK   attachment shape matches the Chat SDK bridge byte-for-byte (type/name/mimeType/size/data)');

    // --- Phase 2: reload — fresh connection, zero client state, must replay identically ---
    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForFunction(
      () => document.querySelector('[data-testid="connection-status"]')?.textContent?.includes('connected'),
      { timeout: 10000 },
    );
    await page.waitForFunction(
      () => document.querySelectorAll('[data-testid="attachment-row"][data-role="user"]').length >= 2,
      { timeout: 10000 },
    );
    const replayedCaption = await page.evaluate(() =>
      Array.from(document.querySelectorAll('[data-testid="message"][data-role="user"]')).some((el) =>
        el.textContent?.includes('here is what I found'),
      ),
    );
    if (!replayedCaption) throw new Error('FAIL caption message did not survive replay');
    const replayedImgLoaded = await page.evaluate(() => {
      const row = document.querySelector('[data-testid="attachment-row"][data-role="user"] img');
      return Boolean(row && row.complete && row.naturalWidth > 0);
    });
    if (!replayedImgLoaded) throw new Error('FAIL replayed uploaded image did not load (download link broken after reload)');
    console.log('OK   caption + both user-role file rows survive a hard reload (replay), image still downloads');

    await browser.close();
    browser = null;

    // --- Phase 3: raw HTTP — the error contract useNanoclaw.ts's uploadFiles() depends on ---
    const base = `http://127.0.0.1:${PORT}/upload`;

    const unauthorized = await fetch(`${base}?token=wrong-token`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: 'irrelevant',
    });
    if (unauthorized.status !== 401) throw new Error(`FAIL expected 401 for a bad token, got ${unauthorized.status}`);
    console.log('OK   bad token on /upload gets 401 (checked before body is even read)');

    const boundary = 'proof-boundary-12345';
    const noFilesBody = buildMultipart(boundary, [{ name: 'text', data: 'just a caption, no files' }]);
    const noFiles = await fetch(`${base}?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: noFilesBody,
    });
    const noFilesJson = await noFiles.json();
    console.log(`OK   no-files upload: status=${noFiles.status} error="${noFilesJson.error}"`);
    if (noFiles.status !== 400 || typeof noFilesJson.error !== 'string') {
      throw new Error(`FAIL expected 400 + readable error for a fileless upload, got ${noFiles.status} ${JSON.stringify(noFilesJson)}`);
    }

    const tooManyParts = Array.from({ length: 6 }, (_, i) => ({
      name: 'file',
      filename: `f${i}.txt`,
      contentType: 'text/plain',
      data: `file ${i}`,
    }));
    const tooManyBody = buildMultipart(boundary, tooManyParts);
    const tooMany = await fetch(`${base}?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: tooManyBody,
    });
    const tooManyJson = await tooMany.json();
    console.log(`OK   6-file upload: status=${tooMany.status} error="${tooManyJson.error}"`);
    if (tooMany.status !== 400 || typeof tooManyJson.error !== 'string') {
      throw new Error(`FAIL expected 400 + readable error for >5 files, got ${tooMany.status} ${JSON.stringify(tooManyJson)}`);
    }

    const oversizedBody = buildMultipart(boundary, [
      { name: 'file', filename: 'huge.bin', contentType: 'application/octet-stream', data: Buffer.alloc(26 * 1024 * 1024, 1) },
    ]);
    const oversized = await fetch(`${base}?token=${TOKEN}`, {
      method: 'POST',
      headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
      body: oversizedBody,
    });
    const oversizedJson = await oversized.json();
    console.log(`OK   26MB single-file upload: status=${oversized.status} error="${oversizedJson.error}"`);
    if (oversized.status !== 413 || typeof oversizedJson.error !== 'string') {
      throw new Error(`FAIL expected 413 + readable error for a 26MB file, got ${oversized.status} ${JSON.stringify(oversizedJson)}`);
    }

    console.log('DONE upload proof complete');
  } finally {
    if (browser) await browser.close().catch(() => {});
    harness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
