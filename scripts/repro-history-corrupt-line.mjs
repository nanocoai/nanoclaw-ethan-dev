// Proof: a corrupt/unparseable line in web-channel-history.jsonl must never
// crash setup() — loadHistoryFromDisk() (web.ts) skips it with a warning and
// keeps going, same as any other best-effort persistence path in this
// adapter (resolveToken(), compactHistoryFile()). Three corruption shapes are
// exercised in the same file: invalid JSON, valid JSON that isn't an object,
// and valid JSON missing the numeric `seq` field a history frame requires.
//
// Self-contained: spawns its own web-channel-harness.ts against a scratch
// dataDir, hand-writes a history file with good + bad lines BEFORE the
// harness ever starts (simulating whatever wrote the corruption — a torn
// write, a manual edit, a future format change), then asserts the process
// comes up healthy and replays exactly the good frames.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7904;
const TOKEN = 'repro-corrupt-line-token';

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

function goodFrame(seq) {
  return { type: 'message', role: 'assistant', text: `good frame #${seq}`, seq, ts: Date.now() };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-corrupt-line-'));
  const historyFile = path.join(dataDir, 'web-channel-history.jsonl');

  // Two good frames, seq 1 and seq 5 (gap is deliberate — the loader must
  // still resume from the highest seq SEEN, 5, not the count of good lines).
  // Between/around them: invalid JSON, a JSON array (valid JSON, not an
  // object), a JSON object with no `seq` at all, and a blank line.
  const lines = [
    JSON.stringify(goodFrame(1)),
    '{not valid json at all',
    '[1, 2, 3]',
    JSON.stringify({ type: 'message', text: 'no seq field here' }),
    '',
    JSON.stringify(goodFrame(5)),
  ];
  fs.writeFileSync(historyFile, lines.join('\n') + '\n');
  console.log(`OK   wrote ${lines.length} lines (2 good, 3 corrupt, 1 blank) to ${historyFile}`);

  const eventLog = path.join(dataDir, 'events.jsonl');
  const harness = spawn(TSX, [path.join(REPO, 'scripts', 'web-channel-harness.ts'), eventLog], {
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
  const watchStderr = (d) => {
    process.stderr.write(`  [harness:err] ${d}`);
    if (/corrupt|malformed/i.test(d.toString())) sawWarning = true;
  };
  harness.stdout.on('data', (d) => {
    process.stdout.write(`  [harness] ${d}`);
    if (/corrupt|malformed/i.test(d.toString())) sawWarning = true;
  });
  harness.stderr.on('data', watchStderr);

  let crashed = false;
  harness.once('exit', (code, signal) => {
    if (signal === null && code !== 0) crashed = true;
  });

  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    console.log('OK   setup() did not crash on a history file with corrupt lines');

    if (crashed) {
      console.error('FAIL harness process exited abnormally during startup');
      process.exit(1);
    }
    if (!sawWarning) {
      console.error('FAIL expected a warn-level log about the corrupt/malformed lines; none seen');
      process.exit(1);
    }
    console.log('OK   saw a warn-level log for the corrupt lines (skipped, not silently ignored)');

    // Fresh connection — confirm exactly the two good frames replay, at
    // their original seqs (1 and 5), and NOTHING from the corrupt lines.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    const historyFrames = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for the history frame')), 5000);
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'history') {
          clearTimeout(timer);
          resolve(frame.frames);
        }
      });
      ws.on('error', reject);
    });

    const seqs = historyFrames.map((f) => f.seq).sort((a, b) => a - b);
    console.log(`OK   replayed history seqs: [${seqs.join(', ')}]`);
    if (seqs.length !== 2 || seqs[0] !== 1 || seqs[1] !== 5) {
      console.error(`FAIL expected exactly [1, 5] replayed, got [${seqs.join(', ')}]`);
      process.exit(1);
    }
    ws.close();

    // A newly emitted frame must resume from seq 6 (max seen was 5, not 2 —
    // proves the loader scanned every line for its max, not just the ones it
    // kept), same monotonicity guarantee repro-seq-monotonic-restart.mjs
    // covers for a real restart.
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    const newSeq = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for a new file frame')), 5000);
      ws2.on('open', () => ws2.send(JSON.stringify({ type: 'user_message', text: 'send file' })));
      ws2.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'file') {
          clearTimeout(timer);
          resolve(frame.seq);
        }
      });
      ws2.on('error', reject);
    });
    console.log(`OK   next emitted frame resumed at seq ${newSeq} (must be > 5)`);
    if (newSeq <= 5) {
      console.error(`FAIL seq did not resume past the max seen in the corrupt file (got ${newSeq})`);
      process.exit(1);
    }
    ws2.close();

    console.log('DONE corrupt-line resilience proof complete');
  } finally {
    harness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
