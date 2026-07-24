// Proof: the ~30s app-level heartbeat (web.ts) is broadcast()-only. It must
// never enter the emit()-recorded history ring buffer, must never carry a
// `seq`, and must not disturb the seq counter real recorded frames rely on
// for idempotent replay (see web.ts emit()/frameSeq and useNanoclaw.ts's
// SeqFrame/hasSeq).
//
// Self-contained like the other repro-*.mjs scripts: spawns its own
// web-channel-harness.ts instance on a scratch port/data dir so it doesn't
// depend on (or interfere with) an already-running harness. No shortcuts on
// the heartbeat interval — waits out two real ~30s cycles.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7898;
const TOKEN = 'repro-heartbeat-token';

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

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-heartbeat-'));
  const eventLog = path.join(dataDir, 'events.jsonl');

  const harness = spawn(TSX, [path.join(REPO, 'scripts', 'web-channel-harness.ts'), eventLog], {
    cwd: REPO,
    env: {
      ...process.env,
      NANOCLAW_WEB_TOKEN: TOKEN,
      NANOCLAW_WEB_PORT: String(PORT),
      WEB_HARNESS_DATADIR: dataDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  harness.stdout.on('data', (d) => process.stdout.write(`  [harness] ${d}`));
  harness.stderr.on('data', (d) => process.stderr.write(`  [harness:err] ${d}`));

  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    console.log('OK   scratch harness up');

    // 1. Connect, send one real message (so history has a seq-bearing frame
    // to compare against), and collect frames until we've seen 2 heartbeat
    // broadcasts (~60s at the real 30s cadence — no shortcuts).
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    const liveFrames = [];
    let firstMessageSeq = null;

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for 2 heartbeats + the recorded message')), 80000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'user_message', text: 'ship it' }));
      });
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        liveFrames.push(frame);
        if (frame.type === 'message' && frame.role === 'user' && firstMessageSeq === null) {
          firstMessageSeq = frame.seq;
        }
        const heartbeats = liveFrames.filter((f) => f.type === 'heartbeat').length;
        if (heartbeats >= 2 && firstMessageSeq !== null) {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on('error', reject);
    });

    const liveHeartbeats = liveFrames.filter((f) => f.type === 'heartbeat');
    console.log(`OK   observed ${liveHeartbeats.length} live heartbeat frames while connected`);
    if (liveHeartbeats.some((f) => 'seq' in f)) {
      console.error('FAIL a live heartbeat frame carries a `seq` — it must not (that would let it leak into seq-based replay merge logic)');
      process.exit(1);
    }
    console.log('OK   live heartbeat frames carry no `seq`');

    ws.close();

    // 2. A NEW client's 'history' replay must never contain a heartbeat
    // frame, no matter how many were broadcast while frame #1 was connected.
    await new Promise((r) => setTimeout(r, 200));
    const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    const historyFrames = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for the history frame')), 5000);
      ws2.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'history') {
          clearTimeout(timer);
          resolve(frame.frames);
        }
      });
      ws2.on('error', reject);
    });

    const heartbeatsInHistory = historyFrames.filter((f) => f.type === 'heartbeat');
    console.log(`OK   history replay contains ${historyFrames.length} frame(s), ${heartbeatsInHistory.length} of them heartbeat`);
    if (heartbeatsInHistory.length > 0) {
      console.error('FAIL heartbeat frame(s) leaked into the replayed history ring buffer');
      process.exit(1);
    }
    console.log('OK   zero heartbeat frames in replayed history');

    // 3. The recorded message's seq must be undisturbed by however many
    // heartbeats were broadcast around it — still the first-ever recorded
    // frame (seq 1), not offset by the heartbeat count.
    const recordedMessage = historyFrames.find((f) => f.type === 'message' && f.role === 'user');
    if (!recordedMessage) {
      console.error('FAIL recorded user message not found in the history replay at all');
      process.exit(1);
    }
    if (recordedMessage.seq !== firstMessageSeq) {
      console.error(`FAIL seq mismatch between live (${firstMessageSeq}) and replayed (${recordedMessage.seq}) copies of the same frame`);
      process.exit(1);
    }
    if (recordedMessage.seq !== 1) {
      console.error(`FAIL expected the first-ever recorded frame to carry seq 1 (heartbeats must not consume seq), got ${recordedMessage.seq}`);
      process.exit(1);
    }
    console.log(`OK   recorded frame seq is undisturbed by any number of heartbeats (seq=${recordedMessage.seq})`);

    ws2.close();
    console.log('DONE heartbeat/history isolation proof complete');
  } finally {
    harness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
