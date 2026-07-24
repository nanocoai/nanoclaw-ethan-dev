// Proof (WU4, trust ON): with `NANOCLAW_WEB_TRUST_TAILSCALE=1`, a request
// carrying a non-empty `Tailscale-User-Login` header authenticates with NO
// token at all — at every auth point web.ts has:
//   - the /ws upgrade (and the resulting `ready` frame echoes the login back
//     as `userId`, which is the whole identity foundation),
//   - POST /upload (files-IN),
//   - GET /files/<id> (attachment download).
// In production that header is injected by `tailscale serve`, which verified
// the tailnet peer itself; here it is simply set on the request, which is the
// same thing from the adapter's point of view (and exactly the forgeability
// caveat documented in web.ts — see repro-tailscale-forge-guard.mjs for the
// half that proves the opt-in is what gates it).
//
// Self-contained like the other repro-*.mjs scripts: spawns its own harness on
// a scratch port/data dir. A token IS configured on that harness (it always is
// — resolveToken generates one otherwise), and is deliberately never presented
// here: every request below is tokenless.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7907;
const TOKEN = 'repro-tailscale-identity-token';
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

async function main() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-ts-identity-'));
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

    // 1. WS upgrade — no ?token= anywhere in the URL, only the header.
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, {
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
      ws.on('close', (code, reason) => {
        clearTimeout(timer);
        reject(new Error(`socket closed before ready (code ${code}, reason "${reason}")`));
      });
      ws.on('error', reject);
    });
    console.log('OK   tokenless WS upgrade accepted on the trusted header alone');

    if (ready.userId !== LOGIN) {
      fail(`ready frame userId is "${ready.userId}", expected the tailnet login "${LOGIN}"`);
    }
    console.log(`OK   ready frame carries userId="${ready.userId}"`);

    // The identity must not have cost the frame anything else it always had.
    if (!('typing' in ready) || !('threadId' in ready)) {
      fail('ready frame lost a pre-existing field (typing/threadId) on the identity path');
    }
    console.log('OK   ready frame still carries its pre-existing fields (threadId, typing)');

    // 2. POST /upload — tokenless, header only.
    const form = new FormData();
    form.append('text', 'uploaded over identity auth');
    form.append('file', new Blob([Buffer.from('identity upload body\n')], { type: 'text/plain' }), 'identity.txt');
    const uploadRes = await fetch(`http://127.0.0.1:${PORT}/upload`, {
      method: 'POST',
      headers: { 'Tailscale-User-Login': LOGIN },
      body: form,
    });
    if (uploadRes.status !== 200) {
      fail(`tokenless /upload with the trusted header returned ${uploadRes.status}, expected 200`);
    }
    const uploaded = await uploadRes.json();
    const downloadPath = uploaded?.files?.[0]?.downloadPath;
    if (!downloadPath) fail(`/upload response carried no downloadPath: ${JSON.stringify(uploaded)}`);
    console.log(`OK   tokenless /upload accepted on the trusted header (${downloadPath})`);

    // 3. GET /files/<id> — tokenless, header only, and the bytes must be the
    // ones that went up (auth accepted, not merely "not 401").
    const downloadRes = await fetch(`http://127.0.0.1:${PORT}${downloadPath}`, {
      headers: { 'Tailscale-User-Login': LOGIN },
    });
    if (downloadRes.status !== 200) {
      fail(`tokenless /files/<id> with the trusted header returned ${downloadRes.status}, expected 200`);
    }
    const body = await downloadRes.text();
    if (body !== 'identity upload body\n') fail(`downloaded body did not round-trip: ${JSON.stringify(body)}`);
    console.log('OK   tokenless /files/<id> download accepted on the trusted header, bytes round-trip');

    // 4. An empty header is not an identity: it must NOT authenticate anyone.
    const emptyHeaderRes = await fetch(`http://127.0.0.1:${PORT}${downloadPath}`, {
      headers: { 'Tailscale-User-Login': '   ' },
    });
    if (emptyHeaderRes.status !== 401) {
      fail(`an empty/whitespace Tailscale-User-Login returned ${emptyHeaderRes.status}, expected 401`);
    }
    console.log('OK   empty/whitespace-only header authenticates nobody (401)');

    ws.close();
    console.log('DONE tailscale-identity (trust ON) proof complete');
  } finally {
    harness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
