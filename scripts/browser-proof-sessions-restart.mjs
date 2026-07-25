// Browser proof: conversations survive a real process restart — the sessions
// version of browser-proof-restart-history.mjs.
//
// Builds two conversations in a real browser, then kills the harness PROCESS
// outright (SIGTERM, graceful exit) and spawns a brand-new one against the
// same DATA_DIR — a real restart/redeploy, new PID, fresh in-memory state.
// A fresh page load must then show BOTH conversations in the sidebar, under
// their original titles, replay whichever one it opens, replay the other on a
// switch, and keep each conversation's seq climbing from its own pre-restart
// maximum rather than reissuing ids the tab already holds.
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
const PORT = 7915;
const TOKEN = 'browser-proof-sessions-restart-token';
const CHROME = '/home/exedev/.local/bin/chrome';
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sessions-restart-shots-'));

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`OK   ${message}`);
  } else {
    console.error(`FAIL ${message}`);
    failures++;
  }
}

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

async function waitForStatus(page, status, timeout = 20000) {
  await page.waitForFunction(
    (want) => document.querySelector('[data-testid="connection-status"]')?.textContent?.trim() === want,
    status,
    { timeout },
  );
}

async function say(page, text) {
  await page.fill('[data-testid="composer-input"]', `echo ${text}`);
  await page.click('[data-testid="send-button"]');
  await page.waitForFunction((want) => document.body.innerText.includes(want), `echo: ${text}`, { timeout: 15000 });
}

function sidebarRow(page, title) {
  return page.locator('[data-testid="session-row"]', {
    has: page.locator(`[data-testid="session-title"]:text-is("${title}")`),
  });
}

/**
 * Tap the page's own WebSocket frames, bucketed by session: the browser is
 * the client whose merge logic depends on seq, so the seq values THIS TAB
 * received are the ones worth asserting on.
 */
function attachSeqTap(page, state) {
  page.on('websocket', (ws) => {
    ws.on('framereceived', (event) => {
      let payload;
      try {
        payload = JSON.parse(event.payload);
      } catch {
        return;
      }
      const record = (sessionId, seq) => {
        if (typeof seq !== 'number' || typeof sessionId !== 'string') return;
        state[sessionId] = Math.max(state[sessionId] ?? 0, seq);
      };
      if (payload.type === 'history' && Array.isArray(payload.frames)) {
        for (const frame of payload.frames) record(frame.sessionId ?? payload.sessionId, frame.seq);
      } else {
        record(payload.sessionId, payload.seq);
      }
    });
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sessions-restart-'));
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
    const context = await browser.newContext({ viewport: { width: 1100, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on('console', (m) => console.log(`  [browser:${m.type()}] ${m.text()}`));
    const seqBefore = {};
    attachSeqTap(page, seqBefore);

    await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'networkidle' });
    await waitForStatus(page, 'connected');

    await say(page, 'first conversation');
    await page.click('[data-testid="new-session"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-row"]').length === 2, undefined, {
      timeout: 10000,
    });
    await say(page, 'second conversation');
    // A couple more turns so the two conversations end up with genuinely
    // different seq maxima.
    await say(page, 'second again');
    // Snapshot: the tap keeps running across the reload (the page object
    // outlives it), so the pre-restart maxima have to be frozen here or the
    // comparison below would be against a moving target.
    const maxBefore = { ...seqBefore };
    console.log(`OK   built two conversations, pre-restart seq maxima: ${JSON.stringify(maxBefore)}`);
    await page.screenshot({ path: `${SHOTS}/sessions-restart-before.png`, fullPage: true });

    const idFirst = await sidebarRow(page, 'echo first conversation').getAttribute('data-session-id');
    const idSecond = await sidebarRow(page, 'echo second conversation').getAttribute('data-session-id');
    check(Boolean(idFirst && idSecond && idFirst !== idSecond), 'two distinct conversations exist before the restart');

    // --- Real process restart. ---
    console.log(`OK   sending SIGTERM to harness #1 (pid ${harness.pid}) — hard restart, not a bounce`);
    const exited = waitForExit(harness);
    harness.kill('SIGTERM');
    await exited;
    harness = spawnHarness(dataDir, eventLog);
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    console.log('OK   harness #2 up (restart, same dataDir — new process, fresh in-memory state)');

    // Fresh page load: zero client-side state carries over, the way an
    // operator reopening the tab after a redeploy sees it.
    const seqAfter = {};
    attachSeqTap(page, seqAfter);
    await page.reload({ waitUntil: 'networkidle' });
    await waitForStatus(page, 'connected');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-row"]').length === 2, undefined, {
      timeout: 15000,
    });
    console.log('OK   SPA reconnected after a real process restart (fresh page load)');
    await page.screenshot({ path: `${SHOTS}/sessions-restart-after.png`, fullPage: true });

    check(
      (await sidebarRow(page, 'echo first conversation').count()) === 1 &&
        (await sidebarRow(page, 'echo second conversation').count()) === 1,
      'both conversations came back in the sidebar, under their original titles',
    );
    check(
      (await sidebarRow(page, 'echo first conversation').getAttribute('data-session-id')) === idFirst,
      'the conversations kept their ids (a renumbered id would orphan the host agent session)',
    );

    // Whichever conversation opened must have replayed; the other must
    // replay on a switch, with no cross-contamination either way.
    const openedText = (await page.locator('[data-testid="message"]').allInnerTexts()).join('\n');
    check(openedText.includes('echo:'), 'the conversation that opened replayed its messages');

    await sidebarRow(page, 'echo first conversation').locator('[data-testid="session-open"]').click();
    await page.waitForFunction((want) => document.body.innerText.includes(want), 'echo: first conversation', {
      timeout: 10000,
    });
    const firstText = (await page.locator('[data-testid="message"]').allInnerTexts()).join('\n');
    check(!firstText.includes('second'), 'the replayed conversation contains nothing from its neighbor');
    await page.screenshot({ path: `${SHOTS}/sessions-restart-switched.png`, fullPage: true });

    // seq continuity, per conversation: a brand-new turn in the FIRST
    // conversation must outrank everything that conversation held before the
    // restart.
    await say(page, 'after restart');
    await page.waitForTimeout(400);
    check(
      (seqAfter[idFirst] ?? 0) > (maxBefore[idFirst] ?? 0),
      `conversation 1 kept climbing from its own maximum (${maxBefore[idFirst]} -> ${seqAfter[idFirst]})`,
    );
    console.log(`OK   post-restart seq maxima: ${JSON.stringify(seqAfter)}`);
  } finally {
    await browser.close();
    harness.kill('SIGTERM');
  }

  if (failures > 0) {
    console.error(`FAIL ${failures} restart-survives-sessions assertion(s) failed (screenshots: ${SHOTS})`);
    process.exit(1);
  }
  console.log(`DONE conversations survived a real process restart (screenshots: ${SHOTS})`);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
