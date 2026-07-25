// Proof: a pre-WU3 install (one `<DATA_DIR>/web-channel-history.jsonl`, no
// sessions directory) boots into the sessions world without losing anything —
// the file becomes the session `default`, its frames replay, and its seq
// counter resumes from the highest seq the OLD file ever held.
//
// This is the upgrade path every deployed WU2 box takes. Two failure modes it
// pins down:
//   - losing the conversation (the new code looks only in the new directory,
//     finds nothing, and the operator's history silently disappears)
//   - adopting it MORE THAN ONCE (a second boot re-imports the same frames,
//     duplicating them, or resets the seq counter and starts reissuing ids a
//     connected client already holds)
//
// Self-contained: writes the legacy file by hand BEFORE the harness ever
// starts, then boots the harness twice against the same scratch dataDir.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7912;
const TOKEN = 'repro-legacy-adoption-token';
const LEGACY_MAX_SEQ = 9;

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

/**
 * Connect and hand back the opening replay + ready frame. The two arrive
 * back to back in the same tick (web.ts sends history then ready with nothing
 * awaited between them), so they are collected from a listener attached
 * BEFORE the socket opens rather than awaited one after the other — a second
 * `waitFor` would attach after both had already landed.
 */
async function openAndSnapshot() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  const frames = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const deadline = Date.now() + 8000;
  for (;;) {
    const history = frames.find((f) => f.type === 'history');
    const ready = frames.find((f) => f.type === 'ready');
    if (history && ready) return { ws, history, ready };
    if (Date.now() > deadline) throw new Error('timeout waiting for the opening replay + ready frames');
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-legacy-adoption-'));
  const legacyFile = path.join(dataDir, 'web-channel-history.jsonl');
  const adoptedFile = path.join(dataDir, 'web-channel-history', 'default.jsonl');

  // A believable pre-WU3 file: a user turn, an assistant answer, and a seq
  // gap (frames evicted by an old compaction) so "resume from the max SEEN"
  // is distinguishable from "resume from the number of lines".
  const legacyFrames = [
    { type: 'message', id: 'user-legacy-1', role: 'user', content: 'legacy question', seq: 1, ts: Date.now() - 60000 },
    { type: 'message', id: 'msg-legacy-2', role: 'assistant', content: 'legacy answer', seq: 2, ts: Date.now() - 59000 },
    { type: 'message', id: 'msg-legacy-9', role: 'assistant', content: 'legacy tail', seq: LEGACY_MAX_SEQ, ts: Date.now() - 58000 },
  ];
  fs.writeFileSync(legacyFile, legacyFrames.map((f) => JSON.stringify(f)).join('\n') + '\n');
  console.log(`OK   wrote a pre-WU3 single-file history (${legacyFrames.length} frames, max seq ${LEGACY_MAX_SEQ})`);

  let harness = spawnHarness(dataDir, path.join(dataDir, 'events.jsonl'));
  process.on('exit', () => {
    try {
      harness.kill('SIGKILL');
    } catch {
      // best-effort — process may already be gone
    }
  });

  let newSeq;
  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    const { ws, history, ready } = await openAndSnapshot();

    check(ready.activeSession === 'default', `the adopted conversation opens as session "default" (got ${ready.activeSession})`);
    check(ready.sessions.length === 1, 'the adopted conversation is the only session');
    check(history.sessionId === 'default', 'the opening replay names the adopted session');
    const contents = history.frames.map((f) => f.content);
    check(
      contents.includes('legacy question') && contents.includes('legacy answer') && contents.includes('legacy tail'),
      'every legacy frame survived the adoption',
    );
    check(
      history.frames.every((f) => legacyFrames.some((lf) => lf.seq === f.seq)),
      'the adopted frames kept their original seqs (nothing renumbered)',
    );
    check(!fs.existsSync(legacyFile), 'the legacy file was moved, not copied (nothing left to adopt twice)');
    check(fs.existsSync(adoptedFile), 'the adopted history lives at web-channel-history/default.jsonl');

    // The seq counter must resume past the legacy MAX, not past the count of
    // frames — the gap in the fixture is what makes those two differ.
    const emitted = waitFor(ws, (f) => f.type === 'message' && f.role === 'user' && f.content === 'echo post-adoption', 'the new user frame');
    ws.send(JSON.stringify({ type: 'user_message', text: 'echo post-adoption' }));
    const frame = await emitted;
    newSeq = frame.seq;
    check(newSeq > LEGACY_MAX_SEQ, `a new frame resumed past the legacy max seq (got ${newSeq}, legacy max was ${LEGACY_MAX_SEQ})`);
    check(frame.sessionId === 'default', 'the new frame landed in the adopted session');
    ws.close();
    await new Promise((r) => setTimeout(r, 200));

    const exited = waitForExit(harness);
    harness.kill('SIGTERM');
    await exited;
    console.log('OK   harness #1 exited');
  } finally {
    if (!harness.killed) harness.kill('SIGKILL');
  }

  // --- Second boot: adoption must NOT run again. ---
  harness = spawnHarness(dataDir, path.join(dataDir, 'events.jsonl'));
  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    const { ws, history, ready } = await openAndSnapshot();
    check(ready.sessions.length === 1, 'the second boot still sees exactly one session (no phantom re-import)');
    const legacyQuestions = history.frames.filter((f) => f.content === 'legacy question').length;
    check(legacyQuestions === 1, `the legacy frames were not duplicated on the second boot (saw ${legacyQuestions} copies)`);

    const emitted = waitFor(ws, (f) => f.type === 'message' && f.role === 'user' && f.content === 'echo second boot', 'the post-restart user frame');
    ws.send(JSON.stringify({ type: 'user_message', text: 'echo second boot' }));
    const frame = await emitted;
    check(frame.seq > newSeq, `seq kept climbing across the restart (got ${frame.seq}, previous max was ${newSeq})`);
    ws.close();
  } finally {
    harness.kill('SIGTERM');
  }

  if (failures > 0) {
    console.error(`FAIL ${failures} legacy-adoption assertion(s) failed`);
    process.exit(1);
  }
  console.log('DONE legacy single-file history adopted once as session "default", frames and seq intact');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
