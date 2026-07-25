// Proof: the WU3 session ops (create / switch / delete) do what the wire
// contract says, including the two properties that are easy to get subtly
// wrong and impossible to see from the UI:
//
//   1. `user_message` WITHOUT a sessionId lands in the connection's active
//      session. That is the back-compat clause every pre-sessions probe
//      script in this directory depends on — none of them know sessions
//      exist, and they must keep working byte-for-byte against a
//      sessions-aware server.
//   2. delete ARCHIVES rather than erases: the conversation's jsonl is
//      renamed to `<id>.jsonl.deleted` with its frames intact (the WU3
//      design's chosen delete semantics), and the id disappears from the
//      live list. A hard unlink would look identical from the UI and lose
//      the conversation forever.
//
// Also covers: per-session seq numbering starting independently at 1, a
// switch replaying the right conversation, an unknown-id switch resyncing
// instead of crashing, and deleting the LAST session immediately opening a
// fresh one (there is always somewhere for a reply to land).
//
// Self-contained: spawns its own web-channel-harness.ts against a scratch
// dataDir/token/port.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7910;
const TOKEN = 'repro-session-ops-token';

let failures = 0;
function check(condition, message) {
  if (condition) {
    console.log(`OK   ${message}`);
  } else {
    console.error(`FAIL ${message}`);
    failures++;
  }
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

/** Open a client and hand back the socket plus every frame it ever received. */
async function connect() {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
  const frames = [];
  ws.on('message', (data) => frames.push(JSON.parse(data.toString())));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return { ws, frames };
}

/** Wait for the first frame satisfying `pred` that arrives AFTER this call. */
function waitFor(ws, pred, what, timeoutMs = 5000) {
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

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-session-ops-'));
  const harness = spawnHarness(dataDir, path.join(dataDir, 'events.jsonl'));
  process.on('exit', () => {
    try {
      harness.kill('SIGKILL');
    } catch {
      // best-effort — process may already be gone
    }
  });

  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    const { ws, frames } = await connect();

    const ready = await waitFor(ws, (f) => f.type === 'ready', 'the ready frame');
    const sessionA = ready.activeSession;
    check(typeof sessionA === 'string' && sessionA.length > 0, `ready names an active session (${sessionA})`);
    check(Array.isArray(ready.sessions) && ready.sessions.length === 1, 'ready carries exactly one session on a fresh dataDir');
    check(ready.threadId === sessionA, 'ready.threadId now names the session this connection opened on');

    // --- 1. user_message with NO sessionId (the pre-sessions wire shape). ---
    const echoedA = waitFor(ws, (f) => f.type === 'message' && f.role === 'user' && f.content === 'echo A1', 'the recorded user message');
    ws.send(JSON.stringify({ type: 'user_message', text: 'echo A1' }));
    const userFrameA = await echoedA;
    check(userFrameA.sessionId === sessionA, 'a sessionId-less user_message landed in the active session (back-compat)');
    check(userFrameA.seq === 1, `the first frame of a session is seq 1 (got ${userFrameA.seq})`);
    await waitFor(ws, (f) => f.type === 'message' && f.content === 'echo: A1', 'the echoed reply in A');

    // Titles: the session is named after its first user message and the new
    // list is pushed to every client. Checked against the whole received
    // log, not a fresh wait — the retitle broadcast precedes the message
    // frame we just awaited, so a wait started here would already have
    // missed it.
    check(
      frames.some((f) => f.type === 'sessions' && f.sessions.some((s) => s.id === sessionA && s.title === 'echo A1')),
      'the session was titled from its first user message and the list was pushed',
    );

    // --- 2. create_session — a brand-new, empty conversation. ---
    const created = waitFor(ws, (f) => f.type === 'history' && f.sessionId !== sessionA, 'the new session replay');
    ws.send(JSON.stringify({ type: 'create_session' }));
    const newHistory = await created;
    const sessionB = newHistory.sessionId;
    check(newHistory.frames.length === 0, 'a new session replays empty');
    check(sessionB !== sessionA, `create_session made a distinct session (${sessionB})`);

    const echoedB = waitFor(ws, (f) => f.type === 'message' && f.role === 'user' && f.content === 'echo B1', 'the recorded user message in B');
    ws.send(JSON.stringify({ type: 'user_message', text: 'echo B1', sessionId: sessionB }));
    const userFrameB = await echoedB;
    check(userFrameB.sessionId === sessionB, 'an explicit sessionId routes the message to that session');
    check(userFrameB.seq === 1, `seq restarts at 1 in a new session, independent of its neighbors (got ${userFrameB.seq})`);
    await waitFor(ws, (f) => f.type === 'message' && f.content === 'echo: B1', 'the echoed reply in B');

    // --- 3. switch back to A — the replay must be A's conversation only. ---
    const replayA = waitFor(ws, (f) => f.type === 'history' && f.sessionId === sessionA, "A's replay");
    ws.send(JSON.stringify({ type: 'switch_session', id: sessionA }));
    const historyA = await replayA;
    const textsA = historyA.frames.filter((f) => f.type === 'message').map((f) => f.content);
    check(textsA.includes('echo A1'), "switching back replays A's own messages");
    check(!textsA.some((t) => t.includes('B1')), "A's replay contains nothing from B");
    check(
      historyA.frames.every((f) => f.sessionId === sessionA),
      'every replayed frame is stamped with the session it belongs to',
    );

    // --- 4. an unknown switch target resyncs instead of crashing. ---
    const resync = waitFor(ws, (f) => f.type === 'sessions', 'a resync of the session list');
    ws.send(JSON.stringify({ type: 'switch_session', id: 'no-such-session' }));
    const resynced = await resync;
    check(resynced.sessions.length === 2, 'an unknown switch target resyncs the list rather than doing nothing');

    // --- 5. delete archives, it does not erase. ---
    const liveFile = path.join(dataDir, 'web-channel-history', `${sessionB}.jsonl`);
    const archived = `${liveFile}.deleted`;
    check(fs.existsSync(liveFile), "B's history file exists before the delete");
    const afterDelete = waitFor(ws, (f) => f.type === 'sessions' && f.sessions.length === 1, 'the post-delete list');
    ws.send(JSON.stringify({ type: 'delete_session', id: sessionB }));
    const listAfterDelete = await afterDelete;
    check(!listAfterDelete.sessions.some((s) => s.id === sessionB), 'the deleted session is gone from the list');
    check(!fs.existsSync(liveFile), "the deleted session's live history file is gone");
    check(fs.existsSync(archived), 'the deleted history was ARCHIVED, not erased');
    if (fs.existsSync(archived)) {
      const archivedText = fs.readFileSync(archived, 'utf8');
      check(archivedText.includes('echo B1'), "the archive still holds the deleted conversation's frames");
    }

    // --- 6. deleting the LAST session opens a fresh one. ---
    const afterLastDelete = waitFor(ws, (f) => f.type === 'sessions' && !f.sessions.some((s) => s.id === sessionA), 'the list after deleting the last session');
    ws.send(JSON.stringify({ type: 'delete_session', id: sessionA }));
    const finalList = await afterLastDelete;
    check(finalList.sessions.length === 1, 'deleting the last conversation immediately opens a fresh one');
    check(finalList.sessions[0].id !== sessionA && finalList.sessions[0].id !== sessionB, 'the replacement session is genuinely new');

    // The client that was viewing the deleted conversation is moved onto the
    // replacement and gets its (empty) replay, rather than being left
    // pointing at a dead id.
    const moved = await waitFor(ws, (f) => f.type === 'history' && f.sessionId === finalList.sessions[0].id, 'the replay of the replacement session', 5000);
    check(moved.frames.length === 0, 'the viewer was moved onto the replacement conversation');

    ws.close();
  } finally {
    harness.kill('SIGTERM');
  }

  if (failures > 0) {
    console.error(`FAIL ${failures} session-op assertion(s) failed`);
    process.exit(1);
  }
  console.log('DONE session ops proof complete (create / switch / delete-archives / sessionId-less back-compat)');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
