// PWA installability proof: the web manifest and its icons must be reachable
// with NO token, exactly like every other static SPA asset (the login page
// itself needs them before a session exists — see authenticate() in
// src/channels/web.ts, which only gates /files/ and /upload). Confirms:
//   - GET /manifest.webmanifest: 200, application/manifest+json, valid JSON
//     with the fields a browser's install prompt needs.
//   - GET /icon-512.png: 200, image/png, non-empty body.
//   - index.html actually links the manifest (so the install prompt fires).
//
// No service worker involved anywhere — this repo deliberately ships none
// (see the PWA comment block in index.html).
//
// Self-contained (spawns its own harness), same pattern as
// repro-file-eviction.mjs.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const PORT = 7920;
const TOKEN = 'repro-pwa-manifest-token';

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
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-pwa-manifest-'));
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

    // Deliberately NO ?token= on any of these — static SPA assets (including
    // the manifest and its icons) must be reachable pre-auth.
    const manifestRes = await fetch(`http://127.0.0.1:${PORT}/manifest.webmanifest`);
    console.log(`OK   GET /manifest.webmanifest (no token): ${manifestRes.status}`);
    if (manifestRes.status !== 200) {
      console.error(`FAIL expected 200 for the manifest with no token, got ${manifestRes.status}`);
      process.exit(1);
    }
    const manifestContentType = manifestRes.headers.get('content-type') ?? '';
    console.log(`OK   manifest content-type: ${manifestContentType}`);
    if (!manifestContentType.includes('application/manifest+json')) {
      console.error(`FAIL expected content-type application/manifest+json, got "${manifestContentType}"`);
      process.exit(1);
    }
    const manifestText = await manifestRes.text();
    if (manifestText.length === 0) {
      console.error('FAIL manifest body is empty');
      process.exit(1);
    }
    const manifest = JSON.parse(manifestText);
    console.log('OK   manifest body parses as JSON');
    const checks = [
      ['name', manifest.name === 'NanoClaw'],
      ['short_name', manifest.short_name === 'NanoClaw'],
      ['display', manifest.display === 'standalone'],
      ['start_url', manifest.start_url === '.'],
      ['scope', manifest.scope === '.'],
      ['background_color', typeof manifest.background_color === 'string' && manifest.background_color.length > 0],
      ['theme_color', typeof manifest.theme_color === 'string' && manifest.theme_color.length > 0],
      ['icons', Array.isArray(manifest.icons) && manifest.icons.length >= 3],
      ['maskable icon present', manifest.icons.some((i) => (i.purpose ?? '').includes('maskable'))],
    ];
    for (const [field, ok] of checks) {
      if (!ok) {
        console.error(`FAIL manifest field check failed: ${field}`, manifest);
        process.exit(1);
      }
    }
    console.log('OK   manifest fields: name, short_name, display, start_url, scope, colors, icons (incl. maskable)');

    for (const icon of manifest.icons) {
      const iconRes = await fetch(`http://127.0.0.1:${PORT}/${icon.src}`);
      console.log(`OK   GET /${icon.src} (no token): ${iconRes.status}`);
      if (iconRes.status !== 200) {
        console.error(`FAIL expected 200 for icon ${icon.src} with no token, got ${iconRes.status}`);
        process.exit(1);
      }
      const iconContentType = iconRes.headers.get('content-type') ?? '';
      if (iconContentType !== 'image/png') {
        console.error(`FAIL expected content-type image/png for ${icon.src}, got "${iconContentType}"`);
        process.exit(1);
      }
      const iconBuf = Buffer.from(await iconRes.arrayBuffer());
      if (iconBuf.length === 0) {
        console.error(`FAIL icon ${icon.src} body is empty`);
        process.exit(1);
      }
      console.log(`OK   ${icon.src}: image/png, ${iconBuf.length} bytes`);
    }

    // apple-touch-icon isn't in the manifest's icons[] (Apple ignores that
    // list) but is linked directly from index.html — check it separately.
    const appleRes = await fetch(`http://127.0.0.1:${PORT}/apple-touch-icon-180.png`);
    if (appleRes.status !== 200 || (appleRes.headers.get('content-type') ?? '') !== 'image/png') {
      console.error(`FAIL apple-touch-icon-180.png: status=${appleRes.status} content-type=${appleRes.headers.get('content-type')}`);
      process.exit(1);
    }
    const appleBuf = Buffer.from(await appleRes.arrayBuffer());
    if (appleBuf.length === 0) {
      console.error('FAIL apple-touch-icon-180.png body is empty');
      process.exit(1);
    }
    console.log(`OK   apple-touch-icon-180.png: image/png, ${appleBuf.length} bytes`);

    // index.html must actually reference the manifest, or none of the above
    // matters — a browser only offers install if the link tag is wired up.
    const indexRes = await fetch(`http://127.0.0.1:${PORT}/index.html`);
    const indexHtml = await indexRes.text();
    if (!/<link rel="manifest" href="\.?\/?manifest\.webmanifest"/.test(indexHtml)) {
      console.error('FAIL index.html does not link the manifest');
      process.exit(1);
    }
    console.log('OK   index.html links the manifest');
    if (/serviceWorker/i.test(indexHtml)) {
      console.error('FAIL index.html references a service worker — this app deliberately ships none');
      process.exit(1);
    }
    console.log('OK   no service worker reference anywhere in index.html');

    console.log('DONE PWA manifest + icons proof complete');
  } finally {
    harness.kill('SIGTERM');
  }
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
