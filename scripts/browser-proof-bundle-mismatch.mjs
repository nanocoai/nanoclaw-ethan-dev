// P2b proof: stale-SPA-bundle detection + reload prompt.
//
// Real incident (twice in one day): a browser tab left open across a server
// deploy keeps running the OLD SPA bundle, then the new server sends frame
// shapes that bundle doesn't know about (role:user echoes rendered as
// duplicates once; a `file` frame silently unrendered another time). Cache
// headers (web.ts, no-store on index.html) fix a plain reload but can't reach
// a tab that's already open and never reloads on its own.
//
// Fix under test: web.ts reads the served SPA's real hashed entry-script
// filename off index.html at setup() time and reports it as `ready.bundle`.
// The SPA (useNanoclaw.ts) reads its OWN entry-script filename from the live
// DOM and compares. On mismatch it reloads itself exactly once (guarded by a
// sessionStorage flag); if still mismatched after that it shows a persistent
// banner instead of looping. No `bundle` field at all (old server) must do
// nothing.
//
// Self-contained like the other repro-*.mjs scripts: spawns its OWN
// web-channel-harness.ts instances on scratch ports/data dirs (one per
// scenario, so each gets a fresh browser-storage origin — sessionStorage is
// origin-scoped, and port counts toward origin — with no cross-scenario
// bleed). Uses the P2b test knob NANOCLAW_WEB_BUNDLE_OVERRIDE (added to the
// harness alongside this proof) to control exactly what the server reports,
// something no amount of clicking in a real deploy could make deterministic.
//
// "How many times did the tab actually reconnect" is read off the harness's
// own "Web client connected" log lines (a real WS handshake, i.e. a genuine
// reload/reconnect — NOT the SPA's harmless history.replaceState() call that
// strips ?token= from the address bar, which is same-document and opens no
// new socket) rather than inferred from Playwright navigation events, which
// fire on same-document URL changes too and would false-positive on exactly
// that replaceState call.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import pw from '/home/exedev/onecli-browser/node_modules/playwright-core/index.js';
const { chromium } = pw;

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.join(here, '..');
const TSX = path.join(REPO, 'node_modules', '.bin', 'tsx');
const CHROME = '/home/exedev/.local/bin/chrome';
const SHOTS = '/home/exedev/nanoco/runbooks/dgx-spark-demo/research/screenshots';
const DIST_INDEX = path.join(REPO, 'src', 'channels', 'web-ui', 'dist', 'index.html');

// Independently re-derived from the REAL dist/index.html (a plain substring
// search, deliberately NOT the same regex web.ts uses) — this is what the
// "match" scenario expects the server to report, and it proves the server's
// real (non-overridden) computation path end-to-end rather than just "some
// value was present".
function realDistBundleFilename() {
  const html = fs.readFileSync(DIST_INDEX, 'utf8');
  const marker = 'assets/';
  const start = html.indexOf(marker);
  if (start === -1) throw new Error(`could not find "${marker}" in ${DIST_INDEX}`);
  const afterMarker = html.slice(start + marker.length);
  const end = afterMarker.indexOf('.js"');
  if (end === -1) throw new Error(`could not find a .js" entry script in ${DIST_INDEX}`);
  return afterMarker.slice(0, end + 3); // include the ".js"
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

function spawnHarness({ port, token, dataDir, bundleOverride }) {
  const env = {
    ...process.env,
    NANOCLAW_WEB_TOKEN: token,
    NANOCLAW_WEB_PORT: String(port),
    WEB_HARNESS_DATADIR: dataDir,
  };
  if (bundleOverride !== undefined) env.NANOCLAW_WEB_BUNDLE_OVERRIDE = bundleOverride;

  const proc = spawn(TSX, [path.join(REPO, 'scripts', 'web-channel-harness.ts')], {
    cwd: REPO,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let connectCount = 0;
  proc.stdout.on('data', (d) => {
    const text = d.toString();
    process.stdout.write(`  [harness:${port}] ${text}`);
    const matches = text.match(/Web client connected/g);
    if (matches) connectCount += matches.length;
  });
  proc.stderr.on('data', (d) => process.stderr.write(`  [harness:${port}:err] ${d}`));

  return { proc, getConnectCount: () => connectCount };
}

async function waitForConnectCount(harness, target, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (harness.getConnectCount() < target) {
    if (Date.now() > deadline) {
      throw new Error(`${label}: timed out waiting for connect count to reach ${target} (stuck at ${harness.getConnectCount()})`);
    }
    await new Promise((r) => setTimeout(r, 200));
  }
}

/** Raw WS probe: connect, capture the `ready` frame, disconnect. No browser involved — proves the server's wire behavior directly. */
async function probeReadyFrame(port, token) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ready frame')), 5000);
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'ready') {
        clearTimeout(timer);
        resolve(frame);
      }
    });
    ws.on('error', reject);
  });
  ws.close();
  return ready;
}

/** Seed one user-role message into server-side history BEFORE any real browser connects, via a raw WS client — proves replay survives whatever this scenario's reload behavior does. */
async function seedHistoryMessage(port, token, text) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws?token=${token}`);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout seeding history message')), 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'user_message', text }));
      // The recorded MessageFrame is emitted synchronously inside
      // handleClientFrame before onInbound is even awaited, so a short grace
      // period is plenty — this is not racing anything async server-side.
      setTimeout(resolve, 300);
    });
    ws.on('error', reject);
  });
  ws.close();
}

async function runScenario({ name, port, bundleOverride, expectReload, expectBanner, expectedReadyBundle }) {
  console.log(`\n=== scenario: ${name} (port ${port}) ===`);
  const token = `bundle-${name}-token`;
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), `nanoclaw-bundle-${name}-`));
  const harness = spawnHarness({ port, token, dataDir, bundleOverride });

  let browser;
  try {
    await waitForHealth(`http://127.0.0.1:${port}/api/health`);
    console.log(`OK   [${name}] harness up`);

    // Direct wire-level check of the ready frame, independent of the browser.
    const rawReady = await probeReadyFrame(port, token);
    const hasBundleKey = Object.prototype.hasOwnProperty.call(rawReady, 'bundle');
    console.log(`OK   [${name}] raw ready frame: hasBundleKey=${hasBundleKey} bundle=${rawReady.bundle ?? '(absent)'}`);
    if (expectedReadyBundle === null) {
      if (hasBundleKey) {
        console.error(`FAIL [${name}] expected the ready frame to omit \`bundle\` entirely, but it was present: ${rawReady.bundle}`);
        process.exit(1);
      }
    } else if (rawReady.bundle !== expectedReadyBundle) {
      console.error(`FAIL [${name}] expected ready.bundle === "${expectedReadyBundle}", got "${rawReady.bundle}"`);
      process.exit(1);
    }
    console.log(`OK   [${name}] ready.bundle matches expectation`);

    const seedText = `seed-${name}-${Date.now()}`;
    await seedHistoryMessage(port, token, seedText);
    console.log(`OK   [${name}] seeded a history message before any real browser connects`);

    const baseline = harness.getConnectCount(); // includes the two raw-ws probes above
    console.log(`OK   [${name}] connect-count baseline = ${baseline}`);

    browser = await chromium.launch({
      executablePath: CHROME,
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--no-proxy-server'],
    });
    const context = await browser.newContext({ viewport: { width: 960, height: 900 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on('console', (m) => console.log(`  [${name}:browser:${m.type()}] ${m.text()}`));

    // domcontentloaded, not networkidle: a mismatch scenario reloads the page
    // itself within moments of connecting, and racing Playwright's own
    // in-flight navigation promise against a page-initiated reload is exactly
    // the kind of flake this proof doesn't need — the connect-count polling
    // below is the real source of truth regardless of what this promise does.
    await page.goto(`http://127.0.0.1:${port}/?token=${encodeURIComponent(token)}`, { waitUntil: 'domcontentloaded' }).catch(() => {
      // A reload firing mid-goto can make this promise reject even though the
      // tab is fine — the polling below is what actually matters.
    });

    const expectedFinalConnectCount = baseline + (expectReload ? 2 : 1);
    await waitForConnectCount(harness, expectedFinalConnectCount, 15000, name);
    console.log(`OK   [${name}] connect count reached ${expectedFinalConnectCount} (baseline ${baseline} + ${expectReload ? 'initial connect + one reload' : 'initial connect only'})`);

    // Stability window: prove it stops there — no reload-loop, no second
    // reload trickling in a moment later.
    await new Promise((r) => setTimeout(r, 4000));
    const settledCount = harness.getConnectCount();
    if (settledCount !== expectedFinalConnectCount) {
      console.error(`FAIL [${name}] connect count kept moving: expected to settle at ${expectedFinalConnectCount}, saw ${settledCount}`);
      process.exit(1);
    }
    console.log(`OK   [${name}] connect count settled at ${settledCount} — no reload-loop`);

    await page.waitForFunction(
      () => document.querySelector('[data-testid="connection-status"]')?.textContent?.trim() === 'connected',
      { timeout: 10000 },
    );
    console.log(`OK   [${name}] SPA shows connected`);

    const bannerVisible = (await page.locator('[data-testid="bundle-update-banner"]').count()) > 0;
    if (bannerVisible !== expectBanner) {
      console.error(`FAIL [${name}] expected banner visible=${expectBanner}, got ${bannerVisible}`);
      process.exit(1);
    }
    console.log(`OK   [${name}] banner visible=${bannerVisible} (expected ${expectBanner})`);

    // The tab still renders history regardless of scenario — the seeded
    // message must have survived whatever reload behavior just happened.
    const seedVisible = await page.evaluate(
      (text) =>
        Array.from(document.querySelectorAll('[data-testid="message"][data-role="user"]')).some((el) => el.textContent?.includes(text)),
      seedText,
    );
    if (!seedVisible) {
      console.error(`FAIL [${name}] seeded history message "${seedText}" is not visible in the DOM after connect`);
      process.exit(1);
    }
    console.log(`OK   [${name}] pre-existing history (seeded message) still renders`);

    await page.screenshot({ path: `${SHOTS}/p2b-bundle-${name}.png`, fullPage: true });
    console.log(`OK   [${name}] screenshot: p2b-bundle-${name}.png`);

    await browser.close();
    browser = undefined;
    console.log(`DONE scenario ${name} passed`);
  } finally {
    if (browser) await browser.close().catch(() => {});
    harness.proc.kill('SIGTERM');
  }
}

async function main() {
  const realBundle = realDistBundleFilename();
  console.log(`Real dist bundle filename (independently re-derived): ${realBundle}`);

  // 1. Mismatch: server reports a bundle that can never match what's really
  //    served. Expect exactly one automatic reload, then a persistent banner
  //    (the reload can't fix it because the override never changes) — and
  //    history must still render throughout.
  await runScenario({
    name: 'mismatch',
    port: 7920,
    bundleOverride: 'index-DOES-NOT-EXIST999.js',
    expectReload: true,
    expectBanner: true,
    expectedReadyBundle: 'index-DOES-NOT-EXIST999.js',
  });

  // 2. Matching bundle (the real production path — no override at all): the
  //    server computes the SAME fingerprint the SPA reads off its own DOM,
  //    so no reload, no banner, ever.
  await runScenario({
    name: 'match',
    port: 7921,
    bundleOverride: undefined,
    expectReload: false,
    expectBanner: false,
    expectedReadyBundle: realBundle,
  });

  // 3. Missing `bundle` field entirely (a pre-P2b server) — backward compat:
  //    must trigger NOTHING, same as a clean match.
  await runScenario({
    name: 'missing-field',
    port: 7922,
    bundleOverride: '__omit__',
    expectReload: false,
    expectBanner: false,
    expectedReadyBundle: null,
  });

  console.log('\nALL SCENARIOS PASSED');
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
