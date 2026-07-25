// Proof (WU4, trust ON — the token fallback stays intact): turning the
// identity opt-in ON must not turn the shared token OFF. Probe scripts, proof
// harnesses and any client reaching the adapter without `tailscale serve` in
// front of it still authenticate exactly as before:
//   - no header + BAD token   -> close 4401 (nothing about the opt-in makes a
//                                bad token pass, and nothing makes it hang)
//   - no header + VALID token -> ready, and NO userId (token auth carries no
//                                identity — the field is omitted, not empty)
//   - header + VALID token    -> ready WITH the header's userId: the token
//                                still authenticates first (precedence
//                                unchanged), but identity is orthogonal — a
//                                trusted header present on the request is
//                                reported either way, so a stored token from
//                                the pre-identity era doesn't hide the login
//   - no header + no token    -> close 4401 (the opt-in is not a free pass)
// and /upload still accepts a valid token with no header at all.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7909;
const TOKEN = 'repro-tailscale-fallback-token';
const LOGIN = 'ethan@nanoco.example';

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

/** Connect and resolve with either `{ ready }` or `{ close: { code, reason } }` — whichever happens first. */
function connect(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    const timer = setTimeout(() => reject(new Error('timeout: socket neither closed nor went ready')), 10000);
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'ready') {
        clearTimeout(timer);
        resolve({ ready: frame, ws });
      }
    });
    ws.on('close', (code, reason) => {
      clearTimeout(timer);
      resolve({ close: { code, reason: reason.toString() } });
    });
    ws.on('error', () => {
      /* a rejected upgrade can also surface here — close/ready above are the signals */
    });
  });
}

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ts-fallback-'));
  const eventLog = path.join(dataDir, 'events.jsonl');

  const harness = spawn(TSX, [path.join(REPO, 'scripts', 'web-channel-harness.ts'), eventLog], {
    cwd: REPO,
    env: {
      ...process.env,
      NANOCLAW_WEB_TOKEN: TOKEN,
      NANOCLAW_WEB_PORT: String(PORT),
      WEB_HARNESS_DATADIR: dataDir,
      NANOCLAW_WEB_TRUST_TAILSCALE: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  harness.stdout.on('data', (d) => process.stdout.write(`  [harness] ${d}`));
  harness.stderr.on('data', (d) => process.stderr.write(`  [harness:err] ${d}`));

  try {
    await waitForHealth(`http://127.0.0.1:${PORT}/api/health`);
    console.log('OK   scratch harness up (trust ON)');

    // 1. No header, bad token.
    const bad = await connect(`ws://127.0.0.1:${PORT}/ws?token=definitely-not-the-token`);
    if (!bad.close) fail('a bad token went READY on a trust-ON server');
    if (bad.close.code !== 4401) fail(`bad token closed with code ${bad.close.code}, expected 4401`);
    console.log('OK   bad token + no header still closes 4401 on a trust-ON server');

    // 2. No header, no token at all — the opt-in alone authenticates nobody.
    const bare = await connect(`ws://127.0.0.1:${PORT}/ws`);
    if (!bare.close) fail('a bare tokenless, headerless connect went READY on a trust-ON server');
    if (bare.close.code !== 4401) fail(`bare connect closed with code ${bare.close.code}, expected 4401`);
    console.log('OK   no token + no header still closes 4401 (opt-in is not a free pass)');

    // 3. No header, valid token — the fallback the proof scripts and probes
    // depend on.
    const good = await connect(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(TOKEN)}`);
    if (!good.ready) fail(`valid token was rejected on a trust-ON server: ${JSON.stringify(good.close)}`);
    if ('userId' in good.ready) {
      fail(`token-authenticated ready frame carried userId="${good.ready.userId}" — it must be absent`);
    }
    console.log('OK   valid token + no header connects, ready frame carries no userId');
    good.ws.close();

    // 4. Valid token AND header — token authenticates (precedence unchanged),
    // but identity is orthogonal: the trusted header's login is reported so a
    // browser with a stored pre-identity token still shows who is connected.
    const both = await connect(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(TOKEN)}`, {
      'Tailscale-User-Login': LOGIN,
    });
    if (!both.ready) fail(`valid token + header was rejected: ${JSON.stringify(both.close)}`);
    if (both.ready.userId !== LOGIN) {
      fail(`token + trusted header must carry the header identity; got userId=${JSON.stringify(both.ready.userId)}`);
    }
    console.log('OK   valid token + header connects, and the trusted identity rides along');
    both.ws.close();

    // 5. /upload with a valid token and no header at all.
    const form = new FormData();
    form.append('file', new Blob([Buffer.from('token upload\n')], { type: 'text/plain' }), 'token.txt');
    const uploadRes = await fetch(`http://127.0.0.1:${PORT}/upload?token=${encodeURIComponent(TOKEN)}`, {
      method: 'POST',
      body: form,
    });
    if (uploadRes.status !== 200) fail(`tokened /upload returned ${uploadRes.status} on a trust-ON server`);
    const uploaded = await uploadRes.json();
    const downloadPath = uploaded?.files?.[0]?.downloadPath;
    if (!downloadPath) fail(`/upload response carried no downloadPath: ${JSON.stringify(uploaded)}`);
    console.log('OK   tokened /upload still accepted on a trust-ON server');

    // 6. ...and the tokened download of what it produced.
    const downloadRes = await fetch(
      `http://127.0.0.1:${PORT}${downloadPath}?token=${encodeURIComponent(TOKEN)}`,
    );
    if (downloadRes.status !== 200) fail(`tokened /files/<id> returned ${downloadRes.status} on a trust-ON server`);
    console.log('OK   tokened /files/<id> download still accepted on a trust-ON server');

    console.log('DONE tailscale token-fallback (trust ON) proof complete');
  } finally {
    harness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
