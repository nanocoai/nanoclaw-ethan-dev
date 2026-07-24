// Proof: `seq` (the monotonic counter emit() stamps on every recorded frame,
// web.ts frameSeq) must never be reissued across a real PROCESS restart, not
// just a teardown()+setup() bounce in the same process. useNanoclaw.ts merges
// a replayed 'history' snapshot with whatever it already applied live by
// keying a Map on `seq` (`bySeq.set(frame.seq, frame)`) — if a restart resets
// the counter to 0 and a brand-new frame is reissued seq=1, it silently
// collides with (and can overwrite, or sort ahead of) whatever frame a client
// already holds under that same key. That's a correctness bug, not just a
// cosmetic one: idempotent, order-tolerant replay is the entire point of
// stamping seq in the first place (see web.ts emit()'s doc comment).
//
// This script is deliberately "fail-before / pass-after": run it against a
// checkout WITHOUT the history-persistence fix (frameSeq always starts at 0
// on a fresh process) and it fails, reporting the exact reissued seq. Run it
// against a checkout WITH the fix (loadHistoryFromDisk() restores frameSeq
// from the on-disk tail at cold-start setup()) and it passes.
//
// Self-contained: spawns its own web-channel-harness.ts TWICE against the
// SAME scratch dataDir/token/port — the second spawn is a real, separate
// process (new PID, new module closure), i.e. an actual restart, not a
// SIGUSR2 in-process bounce (that's what browser-proof-reconnect.mjs covers).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7905;
const TOKEN = 'repro-seq-monotonic-token';
const FRAMES_BEFORE_RESTART = 3;

function waitForExit(child) {
  return new Promise((resolve) => child.once('exit', resolve));
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

/** Send one 'send file' turn, return the recorded `file` frame's seq. */
async function sendFileGetSeq(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for a file frame')), 5000);
    const onMessage = (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'file') {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(frame.seq);
      }
    };
    ws.on('message', onMessage);
    ws.send(JSON.stringify({ type: 'user_message', text: 'send file' }));
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-seq-monotonic-'));
  const eventLog = path.join(dataDir, 'events.jsonl');

  // --- Process 1: build up FRAMES_BEFORE_RESTART recorded frames. ---
  let maxSeqBefore;
  let harness = spawnHarness(dataDir, eventLog);
  // Safety net: process.exit() inside a try below skips its own finally, so
  // without this a failed assertion would leak the harness child process.
  process.on('exit', () => {
    try {
      harness.kill('SIGKILL');
    } catch {
      // best-effort — process may already be gone
    }
  });
  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    console.log('OK   harness #1 up (cold start, empty dataDir)');

    const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      ws1.once('open', resolve);
      ws1.once('error', reject);
    });

    const seqsBefore = [];
    for (let i = 0; i < FRAMES_BEFORE_RESTART; i++) {
      seqsBefore.push(await sendFileGetSeq(ws1));
    }
    console.log(`OK   harness #1 recorded seqs: [${seqsBefore.join(', ')}]`);
    // Each 'send file' turn may record more than one frame (e.g. a message
    // shell plus the file frame itself) — this proof only cares that seq is
    // strictly increasing, not the exact numbering.
    for (let i = 1; i < seqsBefore.length; i++) {
      if (seqsBefore[i] <= seqsBefore[i - 1]) {
        console.error(`FAIL seq did not strictly increase before restart: [${seqsBefore.join(', ')}]`);
        process.exit(1);
      }
    }
    maxSeqBefore = Math.max(...seqsBefore);
    ws1.close();
    await new Promise((r) => setTimeout(r, 150));

    // --- Graceful restart: SIGTERM (same signal a real deploy/systemd stop
    // sends), wait for the process to actually exit, then spawn a FRESH
    // process against the SAME dataDir/token/port — a real restart, new PID,
    // new in-memory closure (frameSeq starts at 0 again unless something
    // restores it from disk).
    console.log(`OK   sending SIGTERM to harness #1 (pid ${harness.pid})`);
    const exited = waitForExit(harness);
    harness.kill('SIGTERM');
    await exited;
    console.log('OK   harness #1 exited');
  } finally {
    if (!harness.killed) harness.kill('SIGKILL');
  }

  harness = spawnHarness(dataDir, eventLog);
  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    console.log('OK   harness #2 up (restart, same dataDir)');

    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    await new Promise((resolve, reject) => {
      ws2.once('open', resolve);
      ws2.once('error', reject);
    });

    const seqAfter = await sendFileGetSeq(ws2);
    ws2.close();

    console.log(`OK   harness #2 recorded seq after restart: ${seqAfter} (must be > ${maxSeqBefore})`);
    if (seqAfter <= maxSeqBefore) {
      console.error(
        `FAIL seq REISSUED across restart: got ${seqAfter}, but seq ${seqAfter} was already used ` +
          `pre-restart (max was ${maxSeqBefore}). A client whose seq-keyed merge (useNanoclaw.ts ` +
          `bySeq.set) already holds the old frame with this seq would silently collide with this ` +
          `new one instead of appending it.`,
      );
      process.exit(1);
    }
    console.log('DONE seq stayed monotonic across a real process restart');
  } finally {
    harness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
