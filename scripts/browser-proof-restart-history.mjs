// Restart-survives proof: the WHOLE POINT of history persistence
// (web-channel-history.jsonl). Unlike browser-proof-reconnect.mjs (which
// bounces the WS/HTTP layer via SIGUSR2 on the SAME adapter instance —
// history survives trivially because it never left the closure), this script
// kills the harness PROCESS outright (SIGTERM, graceful exit) and spawns a
// brand-new process against the same DATA_DIR — a real restart/redeploy, new
// PID, fresh in-memory state. Then a real browser (fresh page load, zero
// client-side cache) reconnects and must see the FULL prior conversation,
// including a file attachment whose bytes are gone (files map is
// deliberately not persisted) — which must render as "no longer available",
// not break the page.
//
// Self-contained: spawns its own harness (twice), own scratch dataDir/port/
// token — doesn't touch or depend on an already-running harness.
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
const PORT = 7906;
const TOKEN = 'browser-proof-restart-history-token';
const CHROME = '/home/exedev/.local/bin/chrome';
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-restart-shots-'));

function spawnHarness(dataDir, eventLog) {
  const child = spawn(TSX, [path.join(REPO, 'scripts', 'web-channel-harness.ts'), eventLog], {
    cwd: REPO,
    env: { ...process.env, NANOCLAW_WEB_TOKEN: TOKEN, NANOCLAW_WEB_PORT: String(PORT), WEB_HARNESS_DATADIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (d) => process.stdout.write(`  [harness] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`  [harness:err] ${d}`));
  return child;
}

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

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', resolve));
}

// Exact match (see browser-proof-reconnect.mjs's comment: 'disconnected'
// contains 'connected' as a literal substring).
async function waitForStatus(page, status, timeout = 15000) {
  await page.waitForFunction(
    (want) => document.querySelector('[data-testid="connection-status"]')?.textContent?.trim() === want,
    status,
    { timeout },
  );
}

/** Attach a WS frame tap on the page so we can see the real seq values the browser client received. */
function attachSeqTap(page, state) {
  page.on('websocket', (ws) => {
    ws.on('framereceived', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.payload);
      } catch {
        return;
      }
      if (payload.type === 'history' && Array.isArray(payload.frames)) {
        state.lastHistorySeqs = payload.frames.filter((f) => typeof f.seq === 'number').map((f) => f.seq);
      } else if (typeof payload.seq === 'number') {
        state.liveSeqs.push(payload.seq);
      }
    });
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-restart-history-'));
  const eventLog = path.join(dataDir, 'events.jsonl');

  let harness = spawnHarness(dataDir, eventLog);
  process.on('exit', () => {
    try {
      harness.kill('SIGKILL');
    } catch {
      // best-effort — process may already be gone
    }
  });
  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-proxy-server'],
  });

  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    console.log('OK   harness #1 up (cold start)');

    const context = await browser.newContext({ viewport: { width: 960, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on('console', (m) => console.log(`  [browser:${m.type()}] ${m.text()}`));
    const seqState = { lastHistorySeqs: [], liveSeqs: [] };
    attachSeqTap(page, seqState);

    await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'networkidle' });
    await waitForStatus(page, 'connected');
    console.log('OK   SPA connected (first connection, pre-restart)');

    // Build up conversation state: a generic card, a full markdown+approval
    // turn, and a file (image) attachment.
    await page.fill('[data-testid="composer-input"]', 'show generic card');
    await page.click('[data-testid="send-button"]');
    await page.waitForSelector('[data-testid="generic-card"]', { timeout: 10000 });

    await page.fill('[data-testid="composer-input"]', 'deploy the arm64 build to production');
    await page.click('[data-testid="send-button"]');
    await page.waitForSelector('[data-testid="approval-card"]', { timeout: 10000 });

    await page.fill('[data-testid="composer-input"]', 'send file');
    await page.click('[data-testid="send-button"]');
    await page.waitForSelector('[data-testid="attachment-image"]', { timeout: 10000 });
    await page.waitForTimeout(300);

    const messageCountBefore = await page.locator('[data-testid="message"]').count();
    const cardCountBefore = await page.locator('[data-testid="approval-card"], [data-testid="generic-card"]').count();
    const attachmentCountBefore = await page.locator('[data-testid="attachment-row"]').count();
    const maxSeqBeforeRestart = Math.max(0, ...seqState.liveSeqs, ...seqState.lastHistorySeqs);
    console.log(
      `OK   built up state: ${messageCountBefore} messages, ${cardCountBefore} cards, ` +
        `${attachmentCountBefore} attachments, maxSeq=${maxSeqBeforeRestart}`,
    );
    await page.screenshot({ path: `${SHOTS}/restart-before.png`, fullPage: true });

    // --- Real process restart: SIGTERM harness #1, wait for actual exit,
    // spawn a FRESH process (new PID) against the SAME dataDir/token/port.
    console.log(`OK   sending SIGTERM to harness #1 (pid ${harness.pid}) — hard restart, not a bounce`);
    const exited = waitForExit(harness);
    harness.kill('SIGTERM');
    await exited;
    console.log('OK   harness #1 exited');

    harness = spawnHarness(dataDir, eventLog);
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    console.log('OK   harness #2 up (restart, same dataDir — new process, fresh in-memory state)');

    // Fresh page load (zero client-side cache) — the real "operator reopens
    // the tab after a restart" shape, not just an in-place WS reconnect.
    seqState.lastHistorySeqs = [];
    seqState.liveSeqs = [];
    await page.reload({ waitUntil: 'networkidle' });
    await waitForStatus(page, 'connected', 20000);
    console.log('OK   SPA reconnected after a real process restart (fresh page load)');
    await page.waitForTimeout(500);

    const messageCountAfter = await page.locator('[data-testid="message"]').count();
    const cardCountAfter = await page.locator('[data-testid="approval-card"], [data-testid="generic-card"]').count();
    // The file item itself must still be REPRESENTED in the conversation —
    // but by design its rendered shape flips from 'attachment-row' (bytes
    // available) to 'attachment-unavailable' (bytes gone) the moment the
    // <img>'s onError fires against a 404, which can happen well inside this
    // 500ms settle window. Count both shapes together for "the file item
    // wasn't silently dropped"; the unavailable-specific assertion follows
    // below.
    const attachmentPresentAfter = await page
      .locator('[data-testid="attachment-row"], [data-testid="attachment-unavailable"]')
      .count();
    console.log(
      `OK   after restart: ${messageCountAfter} messages (was ${messageCountBefore}), ` +
        `${cardCountAfter} cards (was ${cardCountBefore}), ${attachmentPresentAfter} file items present (was ${attachmentCountBefore})`,
    );
    await page.screenshot({ path: `${SHOTS}/restart-after-replay.png`, fullPage: true });

    if (
      messageCountAfter < messageCountBefore ||
      cardCountAfter < cardCountBefore ||
      attachmentPresentAfter < attachmentCountBefore
    ) {
      console.error('FAIL full conversation did not replay after a real process restart');
      process.exit(1);
    }
    console.log('OK   full conversation replayed after a real process restart');

    // seq continuity: the replayed 'history' frame after restart must carry
    // every seq the client had before restart (nothing renumbered/dropped),
    // and a brand-new live turn must get a seq STRICTLY greater than the
    // pre-restart max (never reissued).
    const replayedMax = Math.max(0, ...seqState.lastHistorySeqs);
    console.log(`OK   replayed history max seq = ${replayedMax} (pre-restart max was ${maxSeqBeforeRestart})`);
    if (replayedMax < maxSeqBeforeRestart) {
      console.error('FAIL replayed history is missing frames the client saw pre-restart (seq went backwards)');
      process.exit(1);
    }

    await page.fill('[data-testid="composer-input"]', 'send file');
    await page.click('[data-testid="send-button"]');
    await page.waitForTimeout(500);
    const newLiveSeq = Math.max(0, ...seqState.liveSeqs);
    console.log(`OK   new post-restart live frame seq = ${newLiveSeq} (must be > ${maxSeqBeforeRestart})`);
    if (newLiveSeq <= maxSeqBeforeRestart) {
      console.error('FAIL seq was reissued after restart instead of continuing to climb');
      process.exit(1);
    }
    console.log('OK   seq continuity holds across the real restart');

    // File-bytes-not-persisted: the PRE-restart file attachment's download
    // must now be unavailable (files map reset in the new process) —
    // AttachmentRow.tsx's existing fetch-failure / img-onError path, no SPA
    // change needed. It's an <img>, so this fires automatically on load
    // (no click needed) once the fresh page tries to fetch the image src.
    await page.waitForSelector('[data-testid="attachment-unavailable"]', { timeout: 10000 });
    console.log('OK   pre-restart file attachment shows "no longer available" (bytes not persisted, as designed)');
    await page.screenshot({ path: `${SHOTS}/restart-file-unavailable.png`, fullPage: true });

    console.log(`DONE restart-survives-history proof complete (screenshots: ${SHOTS})`);
  } finally {
    await browser.close();
    harness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
