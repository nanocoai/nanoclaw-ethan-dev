import { EventEmitter } from 'events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const spawnMock = vi.fn();
const spawnSyncMock = vi.fn();
vi.mock('child_process', () => ({
  spawn: (...args: unknown[]) => spawnMock(...args),
  spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
}));

const existsSyncMock = vi.fn();
vi.mock('fs', () => ({ existsSync: (p: string) => existsSyncMock(p) }));
vi.mock('os', () => ({ homedir: () => '/home/tester' }));

const emitStatusMock = vi.fn();
vi.mock('./status.js', () => ({
  emitStatus: (block: string, fields: Record<string, unknown>) =>
    emitStatusMock(block, fields),
}));

// A stand-in for the signal-cli `link` child process.
function makeFakeChild(): EventEmitter & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
}

const LINK_URL = 'sgnl://linkdevice?uuid=abc&pub_key=ZmFrZQ';

describe('cliPath', () => {
  const orig = process.env.SIGNAL_CLI_PATH;
  afterEach(() => {
    if (orig === undefined) delete process.env.SIGNAL_CLI_PATH;
    else process.env.SIGNAL_CLI_PATH = orig;
    vi.resetModules();
  });

  it('honours SIGNAL_CLI_PATH when set', async () => {
    process.env.SIGNAL_CLI_PATH = '/opt/custom/signal-cli';
    const { cliPath } = await import('./signal-auth.js');
    expect(cliPath()).toBe('/opt/custom/signal-cli');
  });

  it('prefers ~/.local/bin/signal-cli even when not on PATH', async () => {
    delete process.env.SIGNAL_CLI_PATH;
    existsSyncMock.mockReturnValue(true);
    const { cliPath } = await import('./signal-auth.js');
    expect(cliPath()).toBe('/home/tester/.local/bin/signal-cli');
    expect(existsSyncMock).toHaveBeenCalledWith('/home/tester/.local/bin/signal-cli');
  });

  it('falls back to the bare name when the local install is absent', async () => {
    delete process.env.SIGNAL_CLI_PATH;
    existsSyncMock.mockReturnValue(false);
    const { cliPath } = await import('./signal-auth.js');
    expect(cliPath()).toBe('signal-cli');
  });
});

describe('withQuietZone', () => {
  const BG = '\x1b[47m';
  const FG = '\x1b[30m';
  const RESET = '\x1b[0m';
  // Two content rows in qrcode's small-terminal form.
  const sample = `${BG}${FG} ▄▄ ${RESET}\n${BG}${FG} █▀ ${RESET}\n`;

  it('adds a white-background quiet zone the terminal bg cannot erase', async () => {
    const { withQuietZone } = await import('./signal-auth.js');
    const out = withQuietZone(sample);
    // One light row top and bottom, so the vertical quiet zone does not depend
    // on the terminal background.
    const strip = (l: string) => l.replace(/\x1b\[[0-9;]*m/g, '');
    expect(strip(out[0]).trim()).toBe('');
    expect(strip(out.at(-1)!).trim()).toBe('');
    expect(out[0].startsWith(BG)).toBe(true);
    // Content rows gain two light columns each side, still white background.
    expect(out[1]).toContain(`${BG}${FG}  `);
    expect(out[1]).toContain(`  ${RESET}`);
    // Additive only: original glyphs survive.
    expect(strip(out[1])).toContain('▄▄');
  });

  it('leaves rows untouched when they are not in the expected form', async () => {
    const { withQuietZone } = await import('./signal-auth.js');
    const plain = 'no-sgr-here\nsecond-line';
    expect(withQuietZone(plain)).toEqual(['no-sgr-here', 'second-line']);
  });
});

describe('run() linking timers', () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    spawnMock.mockReset();
    spawnSyncMock.mockReset();
    emitStatusMock.mockReset();
    existsSyncMock.mockReturnValue(false);
    delete process.env.SIGNAL_CLI_PATH;
    delete process.env.SIGNAL_LINK_SCAN_TIMEOUT_MS;
    delete process.env.SIGNAL_LINK_STARTUP_TIMEOUT_MS;
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((): never => {
      return undefined as never;
    }) as never);
  });

  afterEach(() => {
    vi.useRealTimers();
    exitSpy.mockRestore();
  });

  // spawnSync serves the --version probe and listAccounts; `accounts` is what
  // listAccounts sees AFTER a successful link.
  function primeSpawnSync(accounts: string) {
    spawnSyncMock.mockImplementation((_cli: string, args: string[]) => {
      if (args[0] === '--version') return { status: 0, stdout: '0.14.3' };
      // listAccounts: empty before link, `accounts` after.
      return { status: 0, stdout: linkDone ? accounts : '[]' };
    });
  }
  let linkDone = false;

  it('does not charge cold-start time against the scan budget', async () => {
    linkDone = false;
    primeSpawnSync('[]');
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const { run } = await import('./signal-auth.js');
    const p = run([]);
    await Promise.resolve(); // let run() reach the spawn + timer arming

    // Slow cold start: 30s pass before signal-cli prints the URL.
    vi.advanceTimersByTime(30_000);
    expect(child.kill).not.toHaveBeenCalled();

    // URL appears -> scan budget starts HERE.
    child.stdout.emit('data', Buffer.from(LINK_URL + '\n'));

    // 179s of scanning: total elapsed is 209s, well past the old 180s
    // combined window, but the process must still be alive.
    vi.advanceTimersByTime(179_000);
    expect(child.kill).not.toHaveBeenCalled();

    // Cross the 180s scan budget measured from the QR.
    vi.advanceTimersByTime(2_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(emitStatusMock).toHaveBeenCalledWith(
      'SIGNAL_AUTH',
      expect.objectContaining({ STATUS: 'failed', ERROR: 'qr_timeout' }),
    );
    await p;
  });

  it('fails with a startup error when no URL is ever printed', async () => {
    linkDone = false;
    primeSpawnSync('[]');
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const { run } = await import('./signal-auth.js');
    const p = run([]);
    await Promise.resolve();

    vi.advanceTimersByTime(90_000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(emitStatusMock).toHaveBeenCalledWith(
      'SIGNAL_AUTH',
      expect.objectContaining({ STATUS: 'failed' }),
    );
    const [, fields] = emitStatusMock.mock.calls.at(-1)!;
    expect(String(fields.ERROR)).toMatch(/startup/i);
    await p;
  });

  it('reports success when the link completes before either timeout', async () => {
    linkDone = false;
    primeSpawnSync(JSON.stringify([{ number: '+15551234567', registered: true }]));
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child);

    const { run } = await import('./signal-auth.js');
    const p = run([]);
    await Promise.resolve();

    child.stdout.emit('data', Buffer.from(LINK_URL + '\n'));
    vi.advanceTimersByTime(5_000); // operator scans quickly
    linkDone = true;
    child.emit('close', 0);
    await p;

    expect(child.kill).not.toHaveBeenCalled();
    expect(emitStatusMock).toHaveBeenCalledWith(
      'SIGNAL_AUTH',
      expect.objectContaining({ STATUS: 'success', ACCOUNT: '+15551234567' }),
    );
  });
});
