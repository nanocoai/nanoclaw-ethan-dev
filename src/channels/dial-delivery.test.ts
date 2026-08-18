/**
 * Two invariants the Dial adapter has to hold.
 *
 * 1. A failed send must throw. The delivery layer reads any returned value,
 *    `undefined` included, as delivered: it marks the row and clears the
 *    outbox. Swallowing the error loses the message with no trace.
 * 2. The setup policy choice seeds a line once. `unknown_sender_policy` is an
 *    operator field, so re-applying the file on every event would revert any
 *    later `ncl` change.
 */
import fs from 'node:fs';
import path from 'node:path';

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const tmp = vi.hoisted(() => ({
  root: `${process.env.TMPDIR?.replace(/\/$/, '') ?? '/tmp'}/dial-test-${process.pid}`,
}));
const tmpRoot = tmp.root;

const sdk = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('@getdial/sdk', () => ({
  DialClient: class {
    sendMessage = sdk.send;
  },
}));
vi.mock('./channel-registry.js', () => ({ registerChannelAdapter: vi.fn() }));
vi.mock('./dial-user-agent.js', () => ({ nanoclawUserAgent: () => 'nanoclaw/test' }));
vi.mock('./dial-pairing.js', () => ({ tryConsume: vi.fn(async () => ({ record: null, rateLimited: false })) }));
vi.mock('../env.js', () => ({ readEnvFile: () => ({}) }));
vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
vi.mock('../config.js', () => ({ DATA_DIR: tmp.root }));
vi.mock('../modules/permissions/db/user-roles.js', () => ({ getOwners: () => [] }));
vi.mock('../modules/permissions/db/users.js', () => ({ upsertUser: vi.fn() }));

const db = vi.hoisted(() => ({ rows: [] as any[], updates: [] as any[] }));
vi.mock('../db/messaging-groups.js', () => ({
  getMessagingGroupsByChannel: () => db.rows,
  updateMessagingGroup: (id: string, patch: Record<string, unknown>) => {
    db.updates.push({ id, ...patch });
    const row = db.rows.find((r) => r.id === id);
    if (row) Object.assign(row, patch);
  },
}));

import { createDialAdapter } from './dial.js';

const CONFIG = { apiKey: 'k', fromNumber: '+15550000000', cliPath: 'dial' };

beforeEach(() => {
  sdk.send.mockReset();
  db.rows = [];
  db.updates = [];
  fs.rmSync(path.join(tmpRoot, 'dial'), { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});
afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));
afterEach(() => vi.clearAllMocks());

describe('Dial deliver() surfaces send failures', () => {
  it('throws when the SDK send fails, so the delivery layer can retry', async () => {
    sdk.send.mockRejectedValue(new Error('undelivered'));
    const adapter = createDialAdapter(CONFIG);
    await expect(
      adapter.deliver('+15550000000', '+15551234567', { kind: 'chat', content: { text: 'hi' } } as never),
    ).rejects.toThrow('undelivered');
  });

  it('returns the platform id on success', async () => {
    sdk.send.mockResolvedValue({ id: 'msg-1' });
    const adapter = createDialAdapter(CONFIG);
    await expect(
      adapter.deliver('+15550000000', '+15551234567', { kind: 'chat', content: { text: 'hi' } } as never),
    ).resolves.toBe('msg-1');
  });

  it('still drops silently when there is no text and when there is no recipient', async () => {
    const adapter = createDialAdapter(CONFIG);
    await expect(
      adapter.deliver('+15550000000', '+15551234567', { kind: 'chat', content: { text: '' } } as never),
    ).resolves.toBeUndefined();
    await expect(
      adapter.deliver('+15550000000', null, { kind: 'chat', content: { text: 'hi' } } as never),
    ).resolves.toBeUndefined();
    expect(sdk.send).not.toHaveBeenCalled();
  });
});

describe('Dial seeds the sender policy once per line', () => {
  const seed = (policy: string) => {
    fs.mkdirSync(path.join(tmpRoot, 'dial'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'dial', 'inbound-policy.json'), JSON.stringify({ inboundAccess: policy }));
  };

  it('applies the setup choice, then leaves a later operator change alone', async () => {
    seed('public');
    db.rows = [{ id: 'mg-1', platform_id: '+15550000000', is_group: 1, unknown_sender_policy: 'strict' }];

    const first = createDialAdapter(CONFIG);
    await first.setup({ onInbound: vi.fn() } as never);
    await first.teardown();
    expect(db.rows[0].unknown_sender_policy).toBe('public');

    // Operator tightens the line by hand.
    db.rows[0].unknown_sender_policy = 'request_approval';
    db.updates = [];

    const second = createDialAdapter(CONFIG);
    await second.setup({ onInbound: vi.fn() } as never);
    await second.teardown();

    expect(db.rows[0].unknown_sender_policy).toBe('request_approval');
    expect(db.updates.filter((u) => 'unknown_sender_policy' in u)).toHaveLength(0);
  });

  it('still repairs is_group on every pass', async () => {
    seed('strict');
    db.rows = [{ id: 'mg-1', platform_id: '+15550000000', is_group: 0, unknown_sender_policy: 'strict' }];
    const adapter = createDialAdapter(CONFIG);
    await adapter.setup({ onInbound: vi.fn() } as never);
    await adapter.teardown();
    expect(db.rows[0].is_group).toBe(1);
  });
});
