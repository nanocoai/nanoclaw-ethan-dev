// P2a proof: a `file` frame survives reconnect replay, and its download link
// still works while the file is in the server's in-memory map. Two
// connections against the SAME scratch harness process — the second is a
// fresh WS with zero client-side state, exactly what a hard page reload
// does — proving the replayed 'history' frame carries a working
// downloadPath, not just the metadata.
//
// Self-contained (spawns its own harness), same pattern as
// repro-heartbeat-not-recorded.mjs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7900;
const TOKEN = 'repro-file-replay-token';
// Must match DEMO_PNG in web-channel-harness.ts ('send file' scenario).
const DEMO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const DEMO_PNG = Buffer.from(DEMO_PNG_BASE64, 'base64');

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

async function downloadAndVerify(downloadPath) {
  const url = `http://127.0.0.1:${PORT}${downloadPath}?token=${TOKEN}`;
  const res = await fetch(url);
  if (!res.ok) return { ok: false, status: res.status };
  const body = Buffer.from(await res.arrayBuffer());
  return { ok: true, status: res.status, body };
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-file-replay-'));
  const harness = spawn(TSX, [path.join(REPO, 'scripts', 'web-channel-harness.ts')], {
    cwd: REPO,
    env: { ...process.env, NANOCLAW_WEB_TOKEN: TOKEN, NANOCLAW_WEB_PORT: String(PORT), WEB_HARNESS_DATADIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  harness.stdout.on('data', (d) => process.stdout.write(`  [harness] ${d}`));
  harness.stderr.on('data', (d) => process.stderr.write(`  [harness:err] ${d}`));

  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    console.log('OK   scratch harness up');

    // 1. First connection: deliver the file, capture the live `file` frame.
    const ws1 = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    const liveFrame = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for the live file frame')), 5000);
      ws1.on('open', () => ws1.send(JSON.stringify({ type: 'user_message', text: 'send file' })));
      ws1.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'file') {
          clearTimeout(timer);
          resolve(frame);
        }
      });
      ws1.on('error', reject);
    });
    console.log(`OK   live file frame: id=${liveFrame.id} name=${liveFrame.name} mime=${liveFrame.mime} size=${liveFrame.size}`);

    const liveDownload = await downloadAndVerify(liveFrame.downloadPath);
    if (!liveDownload.ok || !liveDownload.body.equals(DEMO_PNG)) {
      console.error('FAIL live download did not return the original bytes');
      process.exit(1);
    }
    console.log(`OK   live download bytes match original (${liveDownload.body.length} bytes)`);
    ws1.close();
    await new Promise((r) => setTimeout(r, 200));

    // 2. Fresh connection, zero client state — exactly a hard reload.
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

    const replayed = historyFrames.find((f) => f.type === 'file' && f.id === liveFrame.id);
    if (!replayed) {
      console.error('FAIL the file frame is not present in the replayed history — THE REPORTED BUG');
      process.exit(1);
    }
    console.log(`OK   file frame survives reconnect replay (seq=${replayed.seq}, downloadPath=${replayed.downloadPath})`);

    const replayedDownload = await downloadAndVerify(replayed.downloadPath);
    if (!replayedDownload.ok || !replayedDownload.body.equals(DEMO_PNG)) {
      console.error('FAIL the replayed download link no longer works / bytes do not match');
      process.exit(1);
    }
    console.log(`OK   replayed download link still works, bytes match original (${replayedDownload.body.length} bytes)`);

    ws2.close();
    console.log('DONE file-replay proof complete');
  } finally {
    harness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
