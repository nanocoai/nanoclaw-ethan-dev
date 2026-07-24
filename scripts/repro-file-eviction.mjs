// P2a proof: the outbound-file map is bounded (web.ts FILE_COUNT_LIMIT=50) —
// once over the cap the OLDEST files get evicted, and their download links
// answer 410 Gone (not 404 — they existed, they're just gone). Script-level
// only, no browser needed: the SPA-side "no longer available" rendering is
// exercised by AttachmentRow.tsx's onError/fetch-failure handling, which this
// script doesn't drive, but the HTTP contract it depends on (410 vs 200) is
// exactly what's proven here.
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
const PORT = 7901;
const TOKEN = 'repro-file-eviction-token';

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-file-eviction-'));
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

    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${TOKEN}`);
    const fileFrames = [];

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for the flood to complete')), 20000);
      ws.on('open', () => ws.send(JSON.stringify({ type: 'user_message', text: 'flood files' })));
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'file') fileFrames.push(frame);
        if (frame.type === 'message' && frame.role === 'assistant' && frame.content === 'flood done') {
          clearTimeout(timer);
          resolve();
        }
      });
      ws.on('error', reject);
    });

    console.log(`OK   flood delivered ${fileFrames.length} file frames`);
    if (fileFrames.length < 2) {
      console.error('FAIL expected multiple file frames from the flood scenario');
      process.exit(1);
    }

    const oldest = fileFrames[0];
    const newest = fileFrames[fileFrames.length - 1];

    const oldestRes = await fetch(`http://127.0.0.1:${PORT}${oldest.downloadPath}?token=${TOKEN}`);
    console.log(`OK   oldest file (${oldest.name}) download status: ${oldestRes.status}`);
    if (oldestRes.status !== 410) {
      console.error(`FAIL expected 410 Gone for the evicted oldest file, got ${oldestRes.status}`);
      process.exit(1);
    }
    console.log('OK   evicted oldest file answers 410 Gone (not 404 — it existed, it is just gone)');

    const newestRes = await fetch(`http://127.0.0.1:${PORT}${newest.downloadPath}?token=${TOKEN}`);
    console.log(`OK   newest file (${newest.name}) download status: ${newestRes.status}`);
    if (newestRes.status !== 200) {
      console.error(`FAIL expected 200 for the still-registered newest file, got ${newestRes.status}`);
      process.exit(1);
    }
    console.log('OK   newest file (still within the bounded map) downloads fine');

    // A never-existed id must still answer 404, distinct from a real eviction.
    const neverExistedRes = await fetch(`http://127.0.0.1:${PORT}/files/never-existed-id?token=${TOKEN}`);
    console.log(`OK   never-existed id download status: ${neverExistedRes.status}`);
    if (neverExistedRes.status !== 404) {
      console.error(`FAIL expected 404 for an id that never existed, got ${neverExistedRes.status}`);
      process.exit(1);
    }
    console.log('OK   never-existed id answers 404 (distinct from the 410 an eviction produces)');

    ws.close();
    console.log('DONE eviction proof complete');
  } finally {
    harness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
