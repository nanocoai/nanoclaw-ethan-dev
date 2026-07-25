// Browser proof: two conversations, interleaved, in a real browser — the
// headline WU3 behavior.
//
// Drives the SPA the way an operator would: talk in conversation A, start a
// new chat, talk in B, have something land in A while B is on screen (the
// unread dot), then switch back to A and find it exactly as it was, with
// nothing from B mixed in. Also deletes a conversation through the kebab +
// confirm, which is the only destructive control in the sidebar.
//
// The "something lands in A while you are reading B" step is driven from a
// SECOND, raw WebSocket client rather than from the page: the server only
// routes a conversation's frames to clients viewing it, so the browser must
// learn about A's activity through the lightweight `session_activity` marker
// alone — which is exactly the path the dot depends on.
//
// Self-contained: spawns its own harness, own scratch dataDir/port/token.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import pw from '/home/exedev/onecli-browser/node_modules/playwright-core/index.js';
const { chromium } = pw;

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7914;
const TOKEN = 'browser-proof-sessions-token';
const CHROME = '/home/exedev/.local/bin/chrome';
const SHOTS = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sessions-shots-'));

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

// Exact match (see browser-proof-reconnect.mjs: 'disconnected' contains
// 'connected' as a literal substring).
async function waitForStatus(page, status, timeout = 15000) {
  await page.waitForFunction(
    (want) => document.querySelector('[data-testid="connection-status"]')?.textContent?.trim() === want,
    status,
    { timeout },
  );
}

/** Type a message and wait for the harness's echoed answer to render. */
async function say(page, text) {
  await page.fill('[data-testid="composer-input"]', `echo ${text}`);
  await page.click('[data-testid="send-button"]');
  await page.waitForFunction(
    (want) => document.body.innerText.includes(want),
    `echo: ${text}`,
    { timeout: 15000 },
  );
}

/** Everything currently rendered in the conversation pane (messages only, not the sidebar). */
async function conversationText(page) {
  return page.locator('[data-testid="message"]').allInnerTexts();
}

function sidebarRow(page, title) {
  return page.locator('[data-testid="session-row"]', { has: page.locator(`[data-testid="session-title"]:text-is("${title}")`) });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-sessions-'));
  const harness = spawnHarness(dataDir, path.join(dataDir, 'events.jsonl'));
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
    await page.goto(`http://127.0.0.1:${PORT}/?token=${encodeURIComponent(TOKEN)}`, { waitUntil: 'networkidle' });
    await waitForStatus(page, 'connected');
    console.log('OK   SPA connected');

    // --- Conversation A ---
    await say(page, 'alpha');
    await page.waitForSelector('[data-testid="session-title"]', { timeout: 5000 });
    check((await sidebarRow(page, 'echo alpha').count()) === 1, 'the first conversation is titled from its first message');
    await page.screenshot({ path: `${SHOTS}/sessions-a.png`, fullPage: true });

    // --- New chat -> conversation B ---
    await page.click('[data-testid="new-session"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="message"]').length === 0, undefined, {
      timeout: 10000,
    });
    // The pane clears optimistically the moment New chat is clicked; the new
    // ROW appears when the server's session list lands a beat later, so this
    // waits for it rather than sampling in between.
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-row"]').length === 2, undefined, {
      timeout: 10000,
    });
    check(true, 'New chat added a second conversation to the sidebar');

    await say(page, 'bravo');
    const bText = (await conversationText(page)).join('\n');
    check(bText.includes('echo: bravo'), "B shows B's answer");
    check(!bText.includes('alpha'), 'B shows nothing from A (the conversations are genuinely separate)');
    await page.screenshot({ path: `${SHOTS}/sessions-b.png`, fullPage: true });

    // --- Something lands in A while B is on screen: the unread dot. ---
    const rowA = sidebarRow(page, 'echo alpha');
    const sessionA = await rowA.getAttribute('data-session-id');
    check(Boolean(sessionA), `A's session id is readable from the sidebar (${sessionA})`);

    const side = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      side.once('open', resolve);
      side.once('error', reject);
    });
    side.send(JSON.stringify({ type: 'user_message', text: 'echo late', sessionId: sessionA }));
    await page.waitForSelector(`[data-session-id="${sessionA}"] [data-testid="session-unread"]`, { timeout: 10000 });
    console.log('OK   the inactive conversation got an unread dot');
    side.close();

    const stillB = (await conversationText(page)).join('\n');
    check(!stillB.includes('late'), "A's traffic never leaked into the conversation on screen");
    await page.screenshot({ path: `${SHOTS}/sessions-unread.png`, fullPage: true });

    // --- Switch back to A: the whole conversation is there, dot cleared. ---
    await rowA.locator('[data-testid="session-open"]').click();
    await page.waitForFunction(
      (want) => document.body.innerText.includes(want),
      'echo: late',
      { timeout: 10000 },
    );
    const backInA = (await conversationText(page)).join('\n');
    check(backInA.includes('echo alpha') && backInA.includes('echo: alpha'), "A replayed its original turn intact");
    check(backInA.includes('echo late') && backInA.includes('echo: late'), 'A replayed the turn that arrived while it was hidden');
    check(!backInA.includes('bravo'), "nothing from B appears in A");
    check(
      (await page.locator(`[data-session-id="${sessionA}"] [data-testid="session-unread"]`).count()) === 0,
      'the unread dot cleared once the conversation was opened',
    );
    await page.screenshot({ path: `${SHOTS}/sessions-back-in-a.png`, fullPage: true });

    // --- Delete B through the kebab + confirm. ---
    const rowB = sidebarRow(page, 'echo bravo');
    await rowB.locator('[data-testid="session-kebab"]').click();
    await page.click('[data-testid="session-delete"]');
    await page.waitForSelector('[data-testid="session-delete-confirm"]', { timeout: 5000 });
    await page.screenshot({ path: `${SHOTS}/sessions-delete-confirm.png`, fullPage: true });
    await page.click('[data-testid="session-delete-yes"]');
    await page.waitForFunction(() => document.querySelectorAll('[data-testid="session-row"]').length === 1, undefined, {
      timeout: 10000,
    });
    check((await sidebarRow(page, 'echo bravo').count()) === 0, 'the deleted conversation left the sidebar');
    const afterDelete = (await conversationText(page)).join('\n');
    check(afterDelete.includes('echo: alpha'), 'deleting another conversation left the one on screen untouched');
    await page.screenshot({ path: `${SHOTS}/sessions-after-delete.png`, fullPage: true });

    // The archive is the delete semantics WU3 chose — proven on disk here
    // too, since the UI cannot show it.
    const archives = fs.readdirSync(path.join(dataDir, 'web-channel-history')).filter((f) => f.endsWith('.deleted'));
    check(archives.length === 1, `the deleted conversation was archived on disk (${archives.join(', ')})`);
  } finally {
    await browser.close();
    harness.kill('SIGTERM');
  }

  if (failures > 0) {
    console.error(`FAIL ${failures} two-session assertion(s) failed (screenshots: ${SHOTS})`);
    process.exit(1);
  }
  console.log(`DONE two-session interleave proof complete (screenshots: ${SHOTS})`);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
