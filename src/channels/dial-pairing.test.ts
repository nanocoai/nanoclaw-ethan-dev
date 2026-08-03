/**
 * Unit tests for the Dial pairing store — the code-mint / match / supersede
 * logic that backs the wizard's pairing step and the adapter's interceptor.
 * No DB or network: it's a JSON file under a temp path.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  _resetForTest,
  _setStorePathForTest,
  createPairing,
  extractCode,
  tryConsume,
  waitForPairing,
} from './dial-pairing.js';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dial-pairing-'));
  _setStorePathForTest(path.join(dir, 'dial-pairings.json'));
});
afterEach(() => {
  _resetForTest();
  _setStorePathForTest(null);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('extractCode', () => {
  it('accepts a bare 4-digit body only', () => {
    expect(extractCode('1234')).toBe('1234');
    expect(extractCode('  4321 ')).toBe('4321');
    expect(extractCode('my code is 1234')).toBeNull();
    expect(extractCode('12345')).toBeNull();
    expect(extractCode('hello')).toBeNull();
  });
});

describe('createPairing / tryConsume', () => {
  it('mints a 4-digit code and consumes it on an exact match', async () => {
    const rec = await createPairing();
    expect(rec.code).toMatch(/^\d{4}$/);
    expect(rec.status).toBe('pending');

    const consumed = await tryConsume({ text: rec.code, fromNumber: '+15551230000' });
    expect(consumed?.status).toBe('consumed');
    expect(consumed?.consumed?.fromNumber).toBe('+15551230000');
  });

  it('does not consume a non-matching body', async () => {
    const rec = await createPairing();
    expect(await tryConsume({ text: 'not a code', fromNumber: '+1555' })).toBeNull();
    expect(await tryConsume({ text: '9999', fromNumber: '+1555' })).toBeNull(); // wrong 4 digits (assuming != rec.code)
    // The real code still works afterward.
    expect((await tryConsume({ text: rec.code, fromNumber: '+1555' }))?.status).toBe('consumed');
  });

  it('supersedes a prior pending code', async () => {
    const first = await createPairing();
    const second = await createPairing();
    expect(second.code).not.toBe(first.code);
    // The old code no longer matches (invalidated).
    expect(await tryConsume({ text: first.code, fromNumber: '+1555' })).toBeNull();
    expect((await tryConsume({ text: second.code, fromNumber: '+1555' }))?.status).toBe('consumed');
  });
});

describe('waitForPairing', () => {
  it('resolves once the code is consumed', async () => {
    const rec = await createPairing();
    const waiting = waitForPairing(rec.code, 20);
    await tryConsume({ text: rec.code, fromNumber: '+15559998888' });
    const resolved = await waiting;
    expect(resolved.consumed?.fromNumber).toBe('+15559998888');
  });
});
