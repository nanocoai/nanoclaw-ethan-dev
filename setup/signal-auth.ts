/**
 * Step: signal-auth — link this host to an existing Signal account via
 * signal-cli's QR-code flow.
 *
 * signal-cli `link` opens a bi-directional handshake with the Signal
 * servers: it prints one line containing a linking URL (`sgnl://linkdevice?…`
 * or older `tsdevice://linkdevice?…`), then blocks until either the user
 * scans it from an existing Signal install, or the code expires. On
 * success, a secondary account is created under the user's signal-cli
 * data directory, associated with the phone number of the scanner.
 *
 * Methods:
 *   (no args)                    Spawn signal-cli link, render the linking URL
 *                                as a terminal QR, wait for completion.
 *
 * The linking URL + its QR are written as PLAIN stdout lines (not wrapped in a
 * NANOCLAW SETUP block): a streaming parent (setup/lib/skill-driver's
 * hostExecStream) consumes the status blocks but tees every other stdout line to
 * the operator live, so the operator sees the QR/URL directly. Only the terminal
 * SIGNAL_AUTH block is parsed — the driver's `capture:<var>=ACCOUNT` reads the
 * phone number from it.
 *
 * Block schema (parent parses this one block):
 *   SIGNAL_AUTH          { STATUS: success, ACCOUNT: +<digits> }  — terminal
 *                        { STATUS: skipped, ACCOUNT, REASON: already-authenticated }
 *                        { STATUS: failed, ERROR: <reason> }
 *
 * STATUS values match the runner's vocabulary (success/skipped/failed) so
 * spawnStep recognises them and sets `ok` correctly; Signal-specific UI
 * lives in setup/channels/signal.ts.
 *
 * If one or more accounts are already linked (discovered via
 * `signal-cli -o json listAccounts`), the step emits SIGNAL_AUTH
 * STATUS=skipped with the first account so the driver can reuse it.
 * Selecting a different existing account is a driver concern.
 */
import { spawn, spawnSync } from 'child_process';
import { existsSync } from 'fs';
import { homedir } from 'os';
import { join } from 'path';

import { emitStatus } from './status.js';

/**
 * How long the operator gets to scan, measured from the moment the QR is shown
 * — NOT from spawn. signal-cli's native binary is page-cache-cold right after
 * download and can take many seconds to print the linking URL; charging that
 * cold start against the scan budget is what made valid scans time out.
 */
const LINK_SCAN_TIMEOUT_MS = Number(process.env.SIGNAL_LINK_SCAN_TIMEOUT_MS) || 180_000;
/**
 * Separate, generous budget for signal-cli to start and emit the linking URL.
 * If it never prints one we fail with a distinct error instead of a scan
 * timeout the operator can do nothing about.
 */
const LINK_STARTUP_TIMEOUT_MS =
  Number(process.env.SIGNAL_LINK_STARTUP_TIMEOUT_MS) || 90_000;
const DEFAULT_DEVICE_NAME = 'NanoClaw';

interface SignalAccount {
  number?: string;
  account?: string;
  registered?: boolean;
}

/**
 * Resolve the signal-cli binary. Honour SIGNAL_CLI_PATH first, then prefer the
 * known install location `~/.local/bin/signal-cli`: install-signal-cli.sh puts
 * it there, but a freshly spawned shell on Ubuntu/Pop only adds `~/.local/bin`
 * to PATH at login, so the bare name would not resolve in the same setup run.
 * Using the absolute path makes linking work without a re-login. Falls back to
 * the bare name (found on PATH, e.g. the Homebrew install on macOS).
 */
export function cliPath(): string {
  if (process.env.SIGNAL_CLI_PATH) return process.env.SIGNAL_CLI_PATH;
  const local = join(homedir(), '.local', 'bin', 'signal-cli');
  if (existsSync(local)) return local;
  return 'signal-cli';
}

/**
 * Query signal-cli for currently linked accounts. Empty array if none
 * configured, no binary, or the call fails for any other reason.
 */
function listAccounts(): string[] {
  const cli = cliPath();
  try {
    const res = spawnSync(cli, ['-o', 'json', 'listAccounts'], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    if (res.status !== 0) return [];
    const parsed = JSON.parse(res.stdout || '[]') as SignalAccount[];
    return parsed
      .filter((a) => a.registered !== false)
      .map((a) => a.number ?? a.account ?? '')
      .filter(Boolean);
  } catch {
    return [];
  }
}

// qrcode's small-terminal renderer wraps every row in white-background +
// black-foreground SGR codes and gives the code only a one-module quiet zone.
// The white background is the ONLY thing that keeps the code light-on-dark and
// scannable, so if those codes are ever stripped the QR is unreadable, and one
// module is below the four the QR spec wants. `margin` is ignored in small mode,
// so we add the quiet zone ourselves in the same white-background style, keeping
// it independent of the terminal's own background colour.
const QR_BG = '\x1b[47m';
const QR_FG = '\x1b[30m';
const QR_RESET = '\x1b[0m';

/**
 * Surround a small-mode terminal QR with a white-background quiet zone (2 extra
 * light columns each side plus the built-in one, and one light row top and
 * bottom). Additive only — it never clears a dark module — and the result stays
 * within 24 rows. If the rows are not in the expected white-background form
 * (e.g. a future qrcode change), returns them untouched.
 */
export function withQuietZone(qrText: string): string[] {
  const rows = qrText.replace(/\n+$/, '').split('\n');
  if (rows.length === 0 || !rows[0].startsWith(QR_BG)) return rows;
  const bodies = rows.map((r) =>
    r.replace(new RegExp(`^${QR_BG.replace('[', '\\[')}${QR_FG.replace('[', '\\[')}`), '')
      .replace(new RegExp(`${QR_RESET.replace('[', '\\[')}$`), ''),
  );
  const pad = '  ';
  const blank = `${QR_BG}${' '.repeat(bodies[0].length + pad.length * 2)}${QR_RESET}`;
  return [
    blank,
    ...bodies.map((b) => `${QR_BG}${QR_FG}${pad}${b}${pad}${QR_RESET}`),
    blank,
  ];
}

/**
 * Render the signal-cli linking URL as a block-art QR and print it — together
 * with the raw URL — as PLAIN stdout lines. A streaming parent tees these to the
 * operator's terminal live; do NOT wrap them in a NANOCLAW SETUP block (those are
 * consumed by the parser, not displayed). small-mode keeps the code scannable on
 * 24-row terminals. If qrcode isn't installed (the add-signal skill installs it,
 * but be defensive) fall back to the URL alone for an external renderer.
 */
async function renderQr(url: string): Promise<string[]> {
  const scanHint =
    'Signal → Settings → Linked Devices → Link New Device → scan this code.';
  const urlHint = 'Or open this link on the phone running Signal:';
  try {
    const QRCode = await import('qrcode');
    const qrText = await QRCode.toString(url, { type: 'terminal', small: true });
    return ['', ...withQuietZone(qrText), '', scanHint, '', urlHint, url, ''];
  } catch {
    return ['', urlHint, url, '', scanHint, ''];
  }
}

/** Print the linking URL + its QR as plain stdout lines (teed to the operator). */
function printLink(url: string): void {
  void renderQr(url).then((lines) => {
    process.stdout.write(lines.join('\n') + '\n');
  });
}

export async function run(_args: string[]): Promise<void> {
  const cli = cliPath();

  // Verify signal-cli exists before we commit to the long-running link.
  // The driver checks too, but this keeps the step honest when run alone.
  const probe = spawnSync(cli, ['--version'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (probe.error || probe.status !== 0) {
    emitStatus('SIGNAL_AUTH', {
      STATUS: 'failed',
      ERROR: 'signal-cli not found. Install signal-cli first.',
    });
    return;
  }

  const existing = listAccounts();
  if (existing.length > 0) {
    emitStatus('SIGNAL_AUTH', {
      STATUS: 'skipped',
      ACCOUNT: existing[0],
      REASON: 'already-authenticated',
    });
    return;
  }

  await new Promise<void>((resolve) => {
    let settled = false;
    let qrEmitted = false;
    let startupTimer: ReturnType<typeof setTimeout>;
    let scanTimer: ReturnType<typeof setTimeout> | undefined;

    const finish = (block: Record<string, string | number | boolean>, code: number): void => {
      if (settled) return;
      settled = true;
      clearTimeout(startupTimer);
      if (scanTimer) clearTimeout(scanTimer);
      emitStatus('SIGNAL_AUTH', block);
      resolve();
      setTimeout(() => process.exit(code), 500);
    };

    const killLink = (): void => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    };

    // Cold-start guard: signal-cli hasn't printed a linking URL yet. This is
    // NOT the operator's scanning budget — that starts only once the QR shows.
    startupTimer = setTimeout(() => {
      killLink();
      finish(
        {
          STATUS: 'failed',
          ERROR: 'signal-cli did not print a linking URL (startup timed out)',
        },
        1,
      );
    }, LINK_STARTUP_TIMEOUT_MS);

    const child = spawn(cli, ['link', '--name', DEFAULT_DEVICE_NAME], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    // stdout carries the URL on the first line; subsequent lines may print
    // status like "Associated with: +1555…". We don't strictly need to parse
    // the number — listAccounts after exit is the source of truth — but the
    // URL match drives the QR emit, which is the whole point.
    let stdoutBuf = '';
    const handleStdout = (chunk: Buffer): void => {
      stdoutBuf += chunk.toString('utf-8');
      let idx: number;
      while ((idx = stdoutBuf.indexOf('\n')) !== -1) {
        const line = stdoutBuf.slice(0, idx).trim();
        stdoutBuf = stdoutBuf.slice(idx + 1);
        if (!line) continue;
        // Match both modern (sgnl://) and legacy (tsdevice://) schemes. Render
        // the linking URL as a QR and print both as PLAIN stdout lines so a
        // streaming parent tees them straight to the operator (a wrapping
        // NANOCLAW SETUP block would be consumed, not shown).
        if (/^(sgnl|tsdevice):\/\/linkdevice\?/.test(line) && !qrEmitted) {
          qrEmitted = true;
          // The QR is now on screen: stop the cold-start guard and begin the
          // operator's scan budget here, so the full window is theirs to scan.
          clearTimeout(startupTimer);
          printLink(line);
          scanTimer = setTimeout(() => {
            killLink();
            finish({ STATUS: 'failed', ERROR: 'qr_timeout' }, 1);
          }, LINK_SCAN_TIMEOUT_MS);
        }
      }
    };
    child.stdout.on('data', handleStdout);

    // Capture stderr for the transcript / log — signal-cli writes warnings
    // and errors there. We don't emit on partial stderr lines since a
    // successful link can still produce noise.
    let stderrBuf = '';
    child.stderr.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString('utf-8');
    });

    child.on('error', (err) => {
      finish({ STATUS: 'failed', ERROR: `spawn error: ${err.message}` }, 1);
    });

    child.on('close', (code) => {
      // After a successful link, signal-cli exits 0 and the newly linked
      // account shows up in listAccounts. Use that as the source of truth
      // rather than scraping stdout — more robust across signal-cli versions.
      if (code === 0) {
        const post = listAccounts();
        if (post.length === 0) {
          finish(
            { STATUS: 'failed', ERROR: 'link exited 0 but no account registered' },
            1,
          );
          return;
        }
        finish({ STATUS: 'success', ACCOUNT: post[0] }, 0);
        return;
      }

      // Non-zero exit. Surface the last non-empty stderr line for context;
      // signal-cli's own error messages are usually informative.
      const lastErr =
        stderrBuf
          .split('\n')
          .map((l) => l.trim())
          .filter(Boolean)
          .slice(-1)[0] ?? `signal-cli link exited with code ${code}`;
      finish({ STATUS: 'failed', ERROR: lastErr }, 1);
    });
  });
}
