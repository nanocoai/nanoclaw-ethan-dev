/**
 * Dial pairing — proves the operator controls a phone before it's registered.
 *
 * Setup mints a one-time 4-digit code; the operator texts exactly those 4
 * digits to the Dial number from the phone they want registered. The inbound
 * interceptor in dial.ts matches the code, records the sender's number, and
 * (if no owner exists yet) promotes them to owner — all before the message
 * reaches an agent. The message must be exactly the 4 digits; a text that
 * merely contains a 4-digit number does NOT match.
 *
 * Storage is a JSON file at data/dial-pairings.json — single-process,
 * read-modify-write under an in-process mutex. Mirrors telegram-pairing.ts.
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { log } from '../log.js';

export type PairingStatus = 'pending' | 'consumed' | 'invalidated' | 'unknown';

export interface ConsumedDetails {
  /** The phone number (E.164) that sent the code. */
  fromNumber: string;
  consumedAt: string;
}

export interface PairingRecord {
  code: string;
  createdAt: string;
  status: Exclude<PairingStatus, 'unknown'>;
  consumed?: ConsumedDetails;
}

interface Store {
  pairings: PairingRecord[];
}

const FILE_NAME = 'dial-pairings.json';

let storePathOverride: string | null = null;
export function _setStorePathForTest(p: string | null): void {
  storePathOverride = p;
}

function storePath(): string {
  return storePathOverride ?? path.join(DATA_DIR, FILE_NAME);
}

let mutex: Promise<unknown> = Promise.resolve();
function withLock<T>(fn: () => Promise<T> | T): Promise<T> {
  const next = mutex.then(() => fn());
  mutex = next.catch(() => {});
  return next;
}

function readStore(): Store {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), 'utf8')) as Store;
    if (!Array.isArray(parsed.pairings)) return { pairings: [] };
    return parsed;
  } catch {
    return { pairings: [] };
  }
}

function writeStore(store: Store): void {
  const p = storePath();
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, p);
}

/** Keep the store small — retain the most recent 50 records. */
function sweep(store: Store): void {
  if (store.pairings.length > 50) store.pairings = store.pairings.slice(-50);
}

function generateCode(active: Set<string>): string {
  for (let i = 0; i < 50; i++) {
    const code = Math.floor(Math.random() * 10000)
      .toString()
      .padStart(4, '0');
    if (!active.has(code)) return code;
  }
  throw new Error('Could not allocate a free pairing code');
}

/** Mint a fresh pairing code, superseding any prior pending one. */
export async function createPairing(): Promise<PairingRecord> {
  return withLock(() => {
    const store = readStore();
    sweep(store);
    for (const r of store.pairings) {
      if (r.status === 'pending') r.status = 'invalidated';
    }
    const active = new Set(store.pairings.filter((r) => r.status === 'pending').map((r) => r.code));
    const record: PairingRecord = {
      code: generateCode(active),
      createdAt: new Date().toISOString(),
      status: 'pending',
    };
    store.pairings.push(record);
    writeStore(store);
    log.info('Dial pairing created', { code: record.code });
    return record;
  });
}

/** A 4-digit-only body is a code candidate; anything else is not. */
export function extractCode(text: string): string | null {
  const m = text.trim().match(/^(\d{4})$/);
  return m ? m[1] : null;
}

/**
 * Match an inbound SMS body against a pending pairing. On match, marks it
 * consumed and returns the record; returns null on no match.
 */
export async function tryConsume(input: { text: string; fromNumber: string }): Promise<PairingRecord | null> {
  const code = extractCode(input.text);
  if (!code) return null;
  return withLock(() => {
    const store = readStore();
    sweep(store);
    const record = store.pairings.find((r) => r.code === code && r.status === 'pending');
    if (!record) return null;
    record.status = 'consumed';
    record.consumed = { fromNumber: input.fromNumber, consumedAt: new Date().toISOString() };
    writeStore(store);
    log.info('Dial pairing consumed', { code, fromNumber: input.fromNumber });
    return record;
  });
}

export function getPairing(code: string): PairingRecord | null {
  const store = readStore();
  return store.pairings.find((p) => p.code === code) ?? null;
}

/**
 * Resolve when the pairing is consumed; reject when it is superseded/invalidated.
 * Waits indefinitely (codes don't expire) via fs.watch + a slow poll fallback.
 */
export async function waitForPairing(code: string, pollMs = 1000): Promise<PairingRecord> {
  const initial = getPairing(code);
  if (!initial) throw new Error(`Unknown pairing code: ${code}`);

  return new Promise<PairingRecord>((resolve, reject) => {
    let watcher: fs.FSWatcher | null = null;
    let interval: ReturnType<typeof setInterval> | null = null;
    let settled = false;

    const cleanup = () => {
      settled = true;
      try {
        watcher?.close();
      } catch {
        /* ignore */
      }
      if (interval) clearInterval(interval);
    };

    const check = () => {
      if (settled) return;
      const r = getPairing(code);
      if (!r) {
        cleanup();
        reject(new Error(`Pairing ${code} disappeared`));
        return;
      }
      if (r.status === 'consumed') {
        cleanup();
        resolve(r);
      } else if (r.status === 'invalidated') {
        cleanup();
        reject(new Error(`Pairing ${code} was superseded`));
      }
    };

    try {
      const dir = path.dirname(storePath());
      fs.mkdirSync(dir, { recursive: true });
      watcher = fs.watch(dir, (_e, fname) => {
        if (!fname || fname.toString().startsWith(path.basename(storePath()))) check();
      });
    } catch {
      /* fs.watch unsupported — poll-only */
    }
    interval = setInterval(check, pollMs);
    check();
  });
}

/** Test helper — wipe the store. */
export function _resetForTest(): void {
  try {
    fs.unlinkSync(storePath());
  } catch {
    /* ignore */
  }
}
