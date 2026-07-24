// P2a proof: a file deliver() cannot register (empty buffer, here) must
// never be silently dropped. This is the incident this whole feature exists
// to fix — "model sent code as a file, user saw nothing, agent claimed
// success" — for the one case attachment registration itself can hit: an
// unservable OutboundFile. The fallback path mirrors send_card's
// fallbackText handling (web.ts deliver()).
//
// Self-contained: spawns its own scratch web-channel-harness.ts instance
// (same pattern as repro-heartbeat-not-recorded.mjs) so it doesn't depend on
// a manually-started harness.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7899;
const TOKEN = 'repro-never-drop-token';

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-never-drop-'));
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
    const frames = [];

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for the never-drop fallback message')), 5000);
      ws.on('open', () => {
        ws.send(JSON.stringify({ type: 'user_message', text: 'send bad file' }));
      });
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        frames.push(frame);
        if (frame.type === 'file') {
          clearTimeout(timer);
          reject(new Error('FAIL an unservable file (zero-length buffer) still produced a `file` frame — it should have been rejected'));
        }
        if (frame.type === 'message' && frame.role === 'assistant') {
          clearTimeout(timer);
          resolve(frame);
        }
      });
      ws.on('error', reject);
    }).then((frame) => {
      console.log(`OK   never-drop fallback message frame present: "${frame.content}"`);
      if (!frame.content.includes('empty.bin') || !frame.content.toLowerCase().includes('could not be relayed')) {
        console.error(`FAIL fallback message text does not name the file / explain the failure: "${frame.content}"`);
        process.exit(1);
      }
      console.log('OK   fallback message names the file and explains it could not be relayed');
    });

    if (frames.some((f) => f.type === 'file')) {
      console.error('FAIL a `file` frame was recorded for an unservable attachment');
      process.exit(1);
    }
    console.log('OK   no `file` frame was ever recorded for the unservable attachment');

    ws.close();
    console.log('DONE never-drop proof complete');
  } finally {
    harness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
