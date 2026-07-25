// Proof: the session INDEX is a cache, not the source of truth. A corrupt or
// missing `web-channel-history/index.json` must cost titles and ordering at
// worst — never a conversation — because the per-session jsonl files are what
// actually hold the history. Boot must rebuild the index by scanning the
// directory, and a corrupt LINE inside one of those jsonl files must be
// skipped with a warning rather than taking setup() down (the same stance
// repro-history-corrupt-line.mjs pins for the single-file layout, now per
// session).
//
// Corruption shapes exercised here:
//   index.json  — valid JSON that is the wrong shape, i.e. the failure a
//                 plain `JSON.parse` survives and a naive loader then trips
//                 over while reading `.sessions`
//   alpha.jsonl — invalid JSON, a non-object, and an object with no numeric
//                 `seq`, interleaved with good frames
//   a stray file whose name is not a valid session id — must be ignored, not
//                 loaded as a session (that name is also a filename)
//
// Self-contained: writes the whole history directory by hand BEFORE the
// harness starts, against a scratch dataDir/token/port.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7913;
const TOKEN = 'repro-session-index-token';
const ALPHA_MAX_SEQ = 6;

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

/** Connect and collect the opening replay + ready (they arrive back to back — see the legacy-adoption proof). */
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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-session-index-'));
  const dir = path.join(dataDir, 'web-channel-history');
  fs.mkdirSync(dir, { recursive: true });

  const now = Date.now();
  const alphaLines = [
    JSON.stringify({ type: 'message', id: 'u1', role: 'user', content: 'alpha opening question', seq: 1, ts: now - 5000 }),
    '{not valid json at all',
    '[1, 2, 3]',
    JSON.stringify({ type: 'message', id: 'x', content: 'no seq field here' }),
    '',
    JSON.stringify({ type: 'message', id: 'a2', role: 'assistant', content: 'alpha answer', seq: ALPHA_MAX_SEQ, ts: now - 4000 }),
  ];
  fs.writeFileSync(path.join(dir, 'alpha.jsonl'), alphaLines.join('\n') + '\n');
  fs.writeFileSync(
    path.join(dir, 'beta.jsonl'),
    JSON.stringify({ type: 'message', id: 'u2', role: 'user', content: 'beta question', seq: 1, ts: now - 3000 }) + '\n',
  );
  // Valid JSON, wrong shape: survives JSON.parse, has no usable `sessions`.
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ sessions: 'not-an-array', activeSession: 42 }));
  // Not a session id (and not something we would ever want opened as a file).
  fs.writeFileSync(path.join(dir, '..sneaky.jsonl'), JSON.stringify({ type: 'message', content: 'nope', seq: 1 }) + '\n');
  console.log('OK   wrote a history directory with a wrong-shaped index, a corrupt session file, and a bogus filename');

  const harness = spawn(TSX, [path.join(REPO, 'scripts', 'web-channel-harness.ts'), path.join(dataDir, 'events.jsonl')], {
    cwd: REPO,
    env: { ...process.env, NANOCLAW_WEB_TOKEN: TOKEN, NANOCLAW_WEB_PORT: String(PORT), WEB_HARNESS_DATADIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  process.on('exit', () => {
    try {
      harness.kill('SIGKILL');
    } catch {
      // best-effort — process may already be gone
    }
  });
  let sawWarning = false;
  const watch = (d) => {
    if (/corrupt|malformed|not a valid session id/i.test(d.toString())) sawWarning = true;
  };
  harness.stdout.on('data', (d) => {
    process.stdout.write(`  [harness] ${d}`);
    watch(d);
  });
  harness.stderr.on('data', (d) => {
    process.stderr.write(`  [harness:err] ${d}`);
    watch(d);
  });

  let crashed = false;
  harness.once('exit', (code, signal) => {
    if (signal === null && code !== 0) crashed = true;
  });

  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    check(!crashed, 'setup() survived a corrupt index and a corrupt session file');
    check(sawWarning, 'the skipped lines/files were logged, not silently swallowed');

    const { ws, history, ready } = await openAndSnapshot();
    const ids = ready.sessions.map((s) => s.id).sort();
    check(ids.join(',') === 'alpha,beta', `both sessions were rebuilt from the directory scan (got [${ids.join(', ')}])`);
    check(
      !ready.sessions.some((s) => s.id.includes('sneaky') || s.id.includes('..')),
      'a file whose name is not a valid session id was ignored',
    );
    const alpha = ready.sessions.find((s) => s.id === 'alpha');
    check(alpha?.title === 'alpha opening question', `the rebuilt title came from the first user message (got "${alpha?.title}")`);

    // The index was rebuilt on disk too, so the NEXT boot is cheap and
    // ordered — a rebuild that only lived in memory would re-scan forever.
    const rewritten = JSON.parse(fs.readFileSync(path.join(dir, 'index.json'), 'utf8'));
    check(Array.isArray(rewritten.sessions) && rewritten.sessions.length === 2, 'the rebuilt index was written back to disk');

    // Whichever conversation opened, its replay must hold exactly the GOOD
    // frames of that file and nothing from the corrupt lines.
    const opened = history.sessionId;
    const goodContents = history.frames.map((f) => f.content);
    check(
      !goodContents.some((c) => c === 'no seq field here' || c === 'nope'),
      'no corrupt line leaked into the replay',
    );
    if (opened === 'alpha') {
      check(history.frames.length === 2, `alpha replayed exactly its 2 good frames (got ${history.frames.length})`);
    }

    // seq must resume past the max SEEN in the file (6), not past the count
    // of good lines (2) — the gap is what makes those differ.
    const replayAlpha = waitFor(ws, (f) => f.type === 'history' && f.sessionId === 'alpha', "alpha's replay");
    ws.send(JSON.stringify({ type: 'switch_session', id: 'alpha' }));
    await replayAlpha;
    const emitted = waitFor(ws, (f) => f.type === 'message' && f.role === 'user' && f.content === 'echo after corruption', 'the new frame in alpha');
    ws.send(JSON.stringify({ type: 'user_message', text: 'echo after corruption', sessionId: 'alpha' }));
    const frame = await emitted;
    check(frame.seq > ALPHA_MAX_SEQ, `alpha resumed past the max seq seen in its file (got ${frame.seq}, max was ${ALPHA_MAX_SEQ})`);
    ws.close();
  } finally {
    harness.kill('SIGTERM');
  }

  if (failures > 0) {
    console.error(`FAIL ${failures} index-rebuild assertion(s) failed`);
    process.exit(1);
  }
  console.log('DONE corrupt index rebuilt from the directory; corrupt jsonl lines skipped without failing setup()');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
