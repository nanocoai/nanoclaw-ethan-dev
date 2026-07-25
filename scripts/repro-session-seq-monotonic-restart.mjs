// Proof: WU2's seq-monotonicity guarantee still holds once history is split
// per session — now PER SESSION, across a real process restart.
//
// `seq` is monotonic WITHIN a conversation (web.ts SessionState.frameSeq),
// which is exactly what the client's replay merge needs: useNanoclaw.ts keys
// a Map on `seq` for the conversation on screen (`bySeq.set(frame.seq, ...)`)
// and only ever holds one conversation's frames at a time. So the property to
// prove is that a restart resumes EACH session's counter from that session's
// own on-disk maximum — not from zero (a reissued seq silently collides with
// a frame the client already holds) and not from some other session's
// maximum (which would look monotonic while quietly renumbering a
// conversation).
//
// Deliberately fail-before/pass-after in the same shape as
// repro-seq-monotonic-restart.mjs (its single-conversation ancestor): a build
// that forgets to restore a session's frameSeq at boot fails here on the
// first post-restart frame.
//
// Self-contained: spawns its own web-channel-harness.ts TWICE against the
// SAME scratch dataDir/token/port — the second spawn is a real, separate
// process (new PID, new module closure), i.e. an actual restart, not a
// SIGUSR2 in-process bounce.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7911;
const TOKEN = 'repro-session-seq-token';
const TURNS_BEFORE_RESTART = 3;

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`OK   ${message}`);
  } else {
    console.error(`FAIL ${message}`);
    failures++;
  }
}

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

async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}

function waitFor(ws, pred, what, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error(`timeout waiting for ${what}`));
    }, timeoutMs);
    const onMessage = (data) => {
      const frame = JSON.parse(data.toString());
      if (!pred(frame)) return;
      clearTimeout(timer);
      ws.off('message', onMessage);
      resolve(frame);
    };
    ws.on('message', onMessage);
  });
}

/** Point a connection at a session and wait for the server's replay to confirm it. */
async function switchTo(ws, sessionId) {
  const replay = waitFor(ws, (f) => f.type === 'history' && f.sessionId === sessionId, `the replay of ${sessionId}`);
  ws.send(JSON.stringify({ type: 'switch_session', id: sessionId }));
  await replay;
}

/**
 * One echo turn in one session, driven by a connection that is VIEWING that
 * session — the server only routes a conversation's frames to its viewers
 * (everyone else gets an unread marker), so each session gets its own
 * connection here, which is also the honest shape of two conversations open
 * at once. Returns the highest seq that turn produced.
 */
async function echoTurn(ws, sessionId, payload) {
  const reply = waitFor(ws, (f) => f.type === 'message' && f.content === `echo: ${payload}`, `the echo reply for ${payload}`);
  const echoedUser = waitFor(ws, (f) => f.type === 'message' && f.role === 'user' && f.content === `echo ${payload}`, `the recorded send for ${payload}`);
  ws.send(JSON.stringify({ type: 'user_message', text: `echo ${payload}`, sessionId }));
  const userFrame = await echoedUser;
  const replyFrame = await reply;
  if (userFrame.sessionId !== sessionId || replyFrame.sessionId !== sessionId) {
    throw new Error(`a frame for "${payload}" landed in the wrong session`);
  }
  return Math.max(userFrame.seq, replyFrame.seq);
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-session-seq-'));
  const eventLog = path.join(dataDir, 'events.jsonl');

  let harness = spawnHarness(dataDir, eventLog);
  process.on('exit', () => {
    try {
      harness.kill('SIGKILL');
    } catch {
      // best-effort — process may already be gone
    }
  });

  let sessionA;
  let sessionB;
  let maxA = 0;
  let maxB = 0;

  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    console.log('OK   harness #1 up (cold start, empty dataDir)');
    const wsA = await connect();
    const ready = await waitFor(wsA, (f) => f.type === 'ready', 'the ready frame');
    sessionA = ready.activeSession;

    const wsB = await connect();
    await waitFor(wsB, (f) => f.type === 'ready', 'the second connection ready frame');
    const createdB = waitFor(wsB, (f) => f.type === 'history' && f.sessionId !== sessionA, 'the second session');
    wsB.send(JSON.stringify({ type: 'create_session' }));
    sessionB = (await createdB).sessionId;
    console.log(`OK   two sessions: A=${sessionA} B=${sessionB}`);

    // Interleave the turns deliberately: a global counter would hide behind
    // ordered-by-session traffic, but interleaved traffic makes any
    // cross-session numbering leak obvious.
    for (let i = 0; i < TURNS_BEFORE_RESTART; i++) {
      maxA = Math.max(maxA, await echoTurn(wsA, sessionA, `a${i}`));
      maxB = Math.max(maxB, await echoTurn(wsB, sessionB, `b${i}`));
      // B gets an extra turn so the two counters end up genuinely different
      // — if a restart restored the WRONG session's max, the mismatch shows.
      maxB = Math.max(maxB, await echoTurn(wsB, sessionB, `b${i}-extra`));
    }
    console.log(`OK   pre-restart maxima: A=${maxA} B=${maxB}`);
    check(maxA !== maxB, 'the two sessions really do have different seq maxima (the test can distinguish them)');
    wsA.close();
    wsB.close();
    await new Promise((r) => setTimeout(r, 150));

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
    const wsA2 = await connect();
    const ready2 = await waitFor(wsA2, (f) => f.type === 'ready', 'the ready frame after restart');
    check(ready2.sessions.length === 2, `both sessions came back (${ready2.sessions.length})`);
    check(
      ready2.sessions.some((s) => s.id === sessionA) && ready2.sessions.some((s) => s.id === sessionB),
      'both sessions came back under their ORIGINAL ids (a renumbered id would orphan the host agent session)',
    );
    const wsB2 = await connect();
    await waitFor(wsB2, (f) => f.type === 'ready', 'the second connection ready frame after restart');
    await switchTo(wsA2, sessionA);
    await switchTo(wsB2, sessionB);

    const afterA = await echoTurn(wsA2, sessionA, 'after-restart-a');
    const afterB = await echoTurn(wsB2, sessionB, 'after-restart-b');
    console.log(`OK   post-restart first seqs: A=${afterA} (must be > ${maxA}), B=${afterB} (must be > ${maxB})`);
    check(afterA > maxA, `session A resumed past its own max instead of reissuing a seq (got ${afterA}, max was ${maxA})`);
    check(afterB > maxB, `session B resumed past its own max instead of reissuing a seq (got ${afterB}, max was ${maxB})`);
    // The tell for "restored the wrong session's counter": A's fresh seq
    // jumping to B's (higher) numbering rather than continuing its own.
    check(afterA <= maxA + 4, `session A resumed from its OWN counter, not another session's (got ${afterA}, its max was ${maxA})`);
    wsA2.close();
    wsB2.close();
  } finally {
    harness.kill('SIGTERM');
  }

  if (failures > 0) {
    console.error(`FAIL ${failures} per-session seq assertion(s) failed`);
    process.exit(1);
  }
  console.log('DONE per-session seq stayed monotonic across a real process restart');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
