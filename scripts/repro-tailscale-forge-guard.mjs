// Proof (WU4, trust OFF — the forge guard): with `NANOCLAW_WEB_TRUST_TAILSCALE`
// UNSET, a `Tailscale-User-Login` header buys nothing at any auth point. The
// header is trusted ONLY under the explicit env opt-in, so a server that never
// opted in behaves byte-for-byte the way it did before WU4 existed:
//   - /ws upgrade -> completed handshake, then close 4401 "invalid token"
//   - POST /upload -> 401
//   - GET /files/<id> -> 401 (auth before existence, as always)
// and a valid token still authenticates, with NO userId on the `ready` frame
// (identity is only ever known on the header path).
//
// This is the half that makes the documented loopback-forgery caveat an
// OPT-IN risk rather than a standing one.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7908;
const TOKEN = 'repro-tailscale-forge-guard-token';
const LOGIN = 'attacker@nanoco.example';

async function waitForHealth(url, timeoutMs = 15000) {
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

function fail(message) {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

/** Resolves with `{ code, reason }` for a socket that closes before ever going ready. */
function connectExpectingClose(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    const timer = setTimeout(() => reject(new Error('timeout: socket neither closed nor went ready')), 10000);
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'ready') {
        clearTimeout(timer);
        ws.close();
        reject(new Error('socket went READY — it should have been rejected'));
      }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ code, reason: reason.toString() });
    });
    ws.on('error', () => {
      /* a rejected upgrade may also surface as an error — the close handler above is the signal */
    });
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ts-forge-'));
  const eventLog = path.join(dataDir, 'events.jsonl');

  // Explicitly strip the opt-in from the inherited environment: this proof is
  // only meaningful if the child genuinely never sees it.
  const env = {
    ...process.env,
    NANOCLAW_WEB_TOKEN: TOKEN,
    NANOCLAW_WEB_PORT: String(PORT),
    WEB_HARNESS_DATADIR: dataDir,
  };
  delete env.NANOCLAW_WEB_TRUST_TAILSCALE;

  const harness = spawn(TSX, [path.join(REPO, 'scripts', 'web-channel-harness.ts'), eventLog], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  harness.stdout.on('data', (d) => process.stdout.write(`  [harness] ${d}`));
  harness.stderr.on('data', (d) => process.stderr.write(`  [harness:err] ${d}`));

  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    console.log('OK   scratch harness up (trust OFF — opt-in stripped from env)');

    // 1. WS upgrade with the header and no token — must reject exactly as it
    // did before WU4: handshake completed, then app-level close 4401.
    const closed = await connectExpectingClose(`ws://127.0.0.1:${PORT}/ws`, { 'Tailscale-User-Login': LOGIN });
    if (closed.code !== 4401) fail(`WS closed with code ${closed.code}, expected 4401`);
    if (closed.reason !== 'invalid token') fail(`WS close reason was "${closed.reason}", expected "invalid token"`);
    console.log('OK   forged header on /ws rejected: close 4401 "invalid token" (unchanged path)');

    // 2. POST /upload with the header and no token — 401.
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('should never land\n')], { type: 'text/plain' }), 'forged.txt');
    const uploadRes = await fetch(`http://127.0.0.1:${PORT}/upload`, {
      method: 'POST',
      headers: { 'Tailscale-User-Login': LOGIN },
      body: form,
    });
    if (uploadRes.status !== 401) fail(`/upload with a forged header returned ${uploadRes.status}, expected 401`);
    console.log('OK   forged header on /upload rejected: 401');

    // 3. GET /files/<id> with the header and no token — 401, and specifically
    // NOT 404/410: auth is still decided before existence is ever checked, so
    // this can't be used to probe which ids exist.
    const downloadRes = await fetch(`http://127.0.0.1:${PORT}/files/some-id-that-does-not-exist`, {
      headers: { 'Tailscale-User-Login': LOGIN },
    });
    if (downloadRes.status !== 401) {
      fail(`/files/<id> with a forged header returned ${downloadRes.status}, expected 401 (auth before existence)`);
    }
    console.log('OK   forged header on /files/<id> rejected: 401, still auth-before-existence');

    // 4. The token path is untouched by all of the above.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(TOKEN)}`, {
      headers: { 'Tailscale-User-Login': LOGIN },
    });
    const ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout waiting for the ready frame')), 10000);
      ws.on('message', (data) => {
        const frame = JSON.parse(data.toString());
        if (frame.type === 'ready') {
          clearTimeout(timer);
          resolve(frame);
        }
      });
      ws.on('close', (code) => {
        clearTimeout(timer);
        reject(new Error(`valid-token socket closed (code ${code}) instead of going ready`));
      });
      ws.on('error', reject);
    });
    console.log('OK   valid token still authenticates on a trust-OFF server');
    if ('userId' in ready) {
      fail(`ready frame carried userId="${ready.userId}" on a trust-OFF server — the field must be absent entirely`);
    }
    console.log('OK   ready frame carries NO userId (absent, not empty) when the header is not trusted');

    ws.close();
    console.log('DONE tailscale forge-guard (trust OFF) proof complete');
  } finally {
    harness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
