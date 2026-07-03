import { describe, it, expect } from 'bun:test';
import { EventEmitter } from 'events';

import {
  PiProvider,
  buildModelArgs,
  createJsonlReader,
  newTranslateState,
  translatePiEvent,
  type ChildProcessLike,
  type PiRuntimeDeps,
} from './pi.js';
import type { ProviderEvent } from './types.js';

// ── Test doubles ──

class FakeChild extends EventEmitter {
  stdinWrites: string[] = [];
  killed: string[] = [];
  stdinEnded = false;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = {
    write: (data: string): boolean => {
      this.stdinWrites.push(data);
      return true;
    },
    end: (): void => {
      this.stdinEnded = true;
    },
  };

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killed.push(String(signal ?? 'SIGTERM'));
    return true;
  }

  emitLine(obj: unknown): void {
    this.stdout.emit('data', Buffer.from(JSON.stringify(obj) + '\n'));
  }

  /** Parsed commands the provider wrote to stdin. */
  commands(): Array<Record<string, unknown>> {
    return this.stdinWrites.map((w) => JSON.parse(w.trim()));
  }
}

const sleep = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await sleep(1);
  }
}

async function collect(iter: AsyncIterable<ProviderEvent>, sink: ProviderEvent[]): Promise<void> {
  for await (const e of iter) sink.push(e);
}

// ── buildModelArgs ──

describe('buildModelArgs', () => {
  it('omits flags when model is unset', () => {
    expect(buildModelArgs(undefined)).toEqual([]);
  });

  it('passes a slashless value whole as --model', () => {
    expect(buildModelArgs('sonnet')).toEqual(['--model', 'sonnet']);
  });

  it('splits on the FIRST slash into provider + model', () => {
    expect(buildModelArgs('anthropic/claude-sonnet-4/preview')).toEqual([
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-4/preview',
    ]);
  });
});

// ── isSessionInvalid ──

describe('PiProvider.isSessionInvalid', () => {
  const provider = new PiProvider();

  it('matches the verbatim "No session found matching" error', () => {
    expect(provider.isSessionInvalid(new Error("No session found matching 'abc'"))).toBe(true);
  });

  it('matches an invalid-session error', () => {
    expect(provider.isSessionInvalid('invalid session id')).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(provider.isSessionInvalid(new Error('network timeout'))).toBe(false);
  });
});

// ── JSONL framing ──

describe('createJsonlReader', () => {
  it('splits on LF only and does not break on U+2028 inside a JSON string', () => {
    const lines: string[] = [];
    const reader = createJsonlReader((l) => lines.push(l));
    const payload = JSON.stringify({ type: 'x', text: 'before after end' });
    reader.write(payload + '\n');
    expect(lines).toEqual([payload]);
    // The line is still valid JSON with the separators intact inside the string.
    expect((JSON.parse(lines[0]) as { text: string }).text).toBe('before after end');
  });

  it('reassembles records split across chunk boundaries', () => {
    const lines: string[] = [];
    const reader = createJsonlReader((l) => lines.push(l));
    reader.write('{"a":');
    reader.write('1}\n{"b":2}\n');
    expect(lines).toEqual(['{"a":1}', '{"b":2}']);
  });

  it('strips a trailing CR (CRLF input)', () => {
    const lines: string[] = [];
    const reader = createJsonlReader((l) => lines.push(l));
    reader.write('foo\r\nbar\n');
    expect(lines).toEqual(['foo', 'bar']);
  });

  it('flushes a trailing unterminated line on end()', () => {
    const lines: string[] = [];
    const reader = createJsonlReader((l) => lines.push(l));
    reader.write('tail-no-newline');
    reader.end();
    expect(lines).toEqual(['tail-no-newline']);
  });
});

// ── translatePiEvent ──

describe('translatePiEvent', () => {
  it('yields an activity for every event', () => {
    const state = newTranslateState();
    for (const type of ['turn_start', 'tool_execution_start', 'message_start', 'queue_update']) {
      const events = translatePiEvent({ type }, state);
      expect(events[0]).toEqual({ type: 'activity' });
    }
  });

  it('assembles result text from streaming text deltas at agent_end', () => {
    const state = newTranslateState();
    const events: ProviderEvent[] = [];
    events.push(...translatePiEvent({ type: 'agent_start' }, state));
    events.push(...translatePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } }, state));
    events.push(...translatePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' world' } }, state));
    events.push(...translatePiEvent({ type: 'agent_end', messages: [] }, state));
    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: 'Hello world' }]);
  });

  it('prefers the final assistant message text over accumulated deltas', () => {
    const state = newTranslateState();
    translatePiEvent({ type: 'agent_start' }, state);
    translatePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'partial' } }, state);
    const end = translatePiEvent(
      { type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'final answer' }] }] },
      state,
    );
    expect(end.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: 'final answer' }]);
  });

  it('maps a message_update error to a non-retryable error and suppresses the result', () => {
    const state = newTranslateState();
    const mid = translatePiEvent({ type: 'message_update', assistantMessageEvent: { type: 'error', reason: 'error' } }, state);
    expect(mid).toContainEqual({ type: 'error', message: 'pi message error: error', retryable: false });
    const end = translatePiEvent({ type: 'agent_end', messages: [] }, state);
    expect(end.some((e) => e.type === 'result')).toBe(false);
  });

  it('maps a turn stopReason:error to a non-retryable error', () => {
    const state = newTranslateState();
    const events = translatePiEvent({ type: 'turn_end', message: { role: 'assistant', content: [], stopReason: 'error' } }, state);
    expect(events).toContainEqual({ type: 'error', message: 'pi turn ended with an error', retryable: false });
  });

  it('maps auto_retry_start to a retryable error', () => {
    const state = newTranslateState();
    const events = translatePiEvent({ type: 'auto_retry_start', errorMessage: '529 overloaded' }, state);
    expect(events).toContainEqual({ type: 'error', message: '529 overloaded', retryable: true });
  });

  it('maps a failed auto_retry_end to a retryable error', () => {
    const state = newTranslateState();
    const events = translatePiEvent({ type: 'auto_retry_end', success: false, finalError: 'gave up' }, state);
    expect(events).toContainEqual({ type: 'error', message: 'gave up', retryable: true });
  });
});

// ── query() integration over a fake subprocess ──

describe('PiProvider.query', () => {
  it('spawns pi with rpc args, streams a result, and terminates on end', async () => {
    const fake = new FakeChild();
    let spawnArgs: string[] = [];
    const runtime: PiRuntimeDeps = {
      spawn: (_cmd, args) => {
        spawnArgs = args;
        return fake as unknown as ChildProcessLike;
      },
      generateSessionId: () => 'sess-1',
    };
    const provider = new PiProvider({ model: 'anthropic/claude-x' }, runtime);
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const done = collect(query.events, events);

    await waitFor(() => fake.commands().length >= 1);

    expect(spawnArgs.slice(0, 6)).toEqual(['--mode', 'rpc', '--session-id', 'sess-1', '--session-dir', spawnArgs[5]]);
    expect(spawnArgs).toContain('--no-extensions');
    expect(spawnArgs).toContain('--provider');
    expect(spawnArgs[spawnArgs.indexOf('--provider') + 1]).toBe('anthropic');
    expect(fake.commands()[0]).toEqual({ type: 'prompt', message: 'hi' });

    fake.emitLine({ type: 'agent_start' });
    fake.emitLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Hello' } });
    fake.emitLine({ type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: ' world' } });
    fake.emitLine({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'Hello world' }] }] });

    await waitFor(() => events.some((e) => e.type === 'result'));

    query.end();
    fake.emit('exit', 0, 'SIGTERM');
    await done;

    expect(events[0]).toEqual({ type: 'init', continuation: 'sess-1' });
    expect(events.filter((e) => e.type === 'activity').length).toBeGreaterThanOrEqual(4);
    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: 'Hello world' }]);
    expect(fake.killed).toContain('SIGTERM');
  });

  it('reuses a valid continuation, verifies it via get_state, and proceeds when messages exist', async () => {
    const fake = new FakeChild();
    const runtime: PiRuntimeDeps = {
      spawn: () => fake as unknown as ChildProcessLike,
      generateSessionId: () => 'generated',
    };
    const provider = new PiProvider({}, runtime);
    const query = provider.query({ prompt: 'hi again', cwd: '/workspace/agent', continuation: 'prev-session-1' });
    const events: ProviderEvent[] = [];
    const done = collect(query.events, events);

    // The prompt is deferred until get_state confirms the session resumed
    // with history (an unknown --session-id silently creates an empty one).
    await waitFor(() => fake.commands().length >= 1);
    expect(fake.commands()[0]).toEqual({ type: 'get_state' });
    expect(fake.commands().some((c) => c.type === 'prompt')).toBe(false);

    fake.emitLine({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 'prev-session-1', messageCount: 5, isStreaming: false },
    });

    await waitFor(() => fake.commands().some((c) => c.type === 'prompt'));
    expect(fake.commands()[1]).toEqual({ type: 'prompt', message: 'hi again' });

    fake.emitLine({ type: 'agent_start' });
    fake.emitLine({ type: 'agent_end', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'resumed fine' }] }] });
    await waitFor(() => events.some((e) => e.type === 'result'));

    query.end();
    fake.emit('exit', 0, 'SIGTERM');
    await done;

    expect(events[0]).toEqual({ type: 'init', continuation: 'prev-session-1' });
    expect(events.some((e) => e.type === 'error')).toBe(false);
    expect(events.filter((e) => e.type === 'result')).toEqual([{ type: 'result', text: 'resumed fine' }]);
  });

  it('does not issue a get_state resume check when no continuation is supplied', async () => {
    const fake = new FakeChild();
    const runtime: PiRuntimeDeps = {
      spawn: () => fake as unknown as ChildProcessLike,
      generateSessionId: () => 'sess-1',
    };
    const provider = new PiProvider({}, runtime);
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const done = collect(query.events, events);

    await waitFor(() => fake.commands().length >= 1);
    expect(fake.commands()[0]).toEqual({ type: 'prompt', message: 'hi' });
    expect(fake.commands().some((c) => c.type === 'get_state')).toBe(false);

    query.abort();
    fake.emit('exit', null, 'SIGTERM');
    await done;
  });

  it('steers follow-ups while streaming and sends a fresh prompt when idle', async () => {
    const fake = new FakeChild();
    const runtime: PiRuntimeDeps = {
      spawn: () => fake as unknown as ChildProcessLike,
      generateSessionId: () => 'sess-1',
    };
    const provider = new PiProvider({}, runtime);
    const query = provider.query({ prompt: 'first', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const done = collect(query.events, events);

    await waitFor(() => fake.commands().length >= 1);
    // Initial prompt marks the turn streaming, so a follow-up must steer.
    query.push('mid-turn');
    await waitFor(() => fake.commands().length >= 2);
    expect(fake.commands()[1]).toEqual({ type: 'steer', message: 'mid-turn' });

    // After agent_end the turn is idle again: the next push is a fresh prompt.
    fake.emitLine({ type: 'agent_end', messages: [] });
    await waitFor(() => events.some((e) => e.type === 'result'));
    query.push('next-turn');
    await waitFor(() => fake.commands().length >= 3);
    expect(fake.commands()[2]).toEqual({ type: 'prompt', message: 'next-turn' });

    query.end();
    fake.emit('exit', 0, 'SIGTERM');
    await done;
  });

  it('sends an abort command and kills the subprocess on abort, emitting no result', async () => {
    const fake = new FakeChild();
    const runtime: PiRuntimeDeps = {
      spawn: () => fake as unknown as ChildProcessLike,
      generateSessionId: () => 'sess-1',
    };
    const provider = new PiProvider({}, runtime);
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const done = collect(query.events, events);

    await waitFor(() => fake.commands().length >= 1);
    query.abort();
    fake.emit('exit', null, 'SIGTERM');
    await done;

    expect(fake.commands().some((c) => c.type === 'abort')).toBe(true);
    expect(fake.killed).toContain('SIGTERM');
    expect(events.some((e) => e.type === 'result')).toBe(false);
  });

  it('auto-cancels extension UI dialog requests', async () => {
    const fake = new FakeChild();
    const runtime: PiRuntimeDeps = {
      spawn: () => fake as unknown as ChildProcessLike,
      generateSessionId: () => 'sess-1',
    };
    const provider = new PiProvider({}, runtime);
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent' });
    const events: ProviderEvent[] = [];
    const done = collect(query.events, events);

    await waitFor(() => fake.commands().length >= 1);
    fake.emitLine({ type: 'extension_ui_request', id: 'ui-1', method: 'confirm', title: 'ok?' });
    await waitFor(() => fake.commands().some((c) => c.type === 'extension_ui_response'));
    expect(fake.commands().find((c) => c.type === 'extension_ui_response')).toEqual({
      type: 'extension_ui_response',
      id: 'ui-1',
      cancelled: true,
    });

    query.abort();
    fake.emit('exit', null, 'SIGTERM');
    await done;
  });

  it('detects a lost transcript via get_state (0 messages), kills pi, and throws a session-invalid error', async () => {
    const fake = new FakeChild();
    const runtime: PiRuntimeDeps = {
      spawn: () => fake as unknown as ChildProcessLike,
      generateSessionId: () => 'sess-1',
    };
    const provider = new PiProvider({}, runtime);
    const query = provider.query({ prompt: 'hi', cwd: '/workspace/agent', continuation: 'gone-1' });
    const events: ProviderEvent[] = [];

    const drain = (async () => {
      try {
        await collect(query.events, events);
        return null;
      } catch (err) {
        return err;
      }
    })();

    await waitFor(() => fake.commands().length >= 1);
    expect(fake.commands()[0]).toEqual({ type: 'get_state' });

    // pi 0.80.3 with --session-id and an unknown id silently creates a fresh
    // empty session — messageCount 0 under a supplied continuation is the
    // only observable signal that the backing transcript is gone.
    fake.emitLine({
      type: 'response',
      command: 'get_state',
      success: true,
      data: { sessionId: 'gone-1', messageCount: 0, isStreaming: false },
    });

    // provider terminates; the subprocess then exits.
    await waitFor(() => fake.killed.length >= 1);
    expect(fake.killed).toContain('SIGTERM');
    fake.emit('exit', 0, 'SIGTERM');

    const thrown = await drain;
    expect(thrown).toBeInstanceOf(Error);
    expect(provider.isSessionInvalid(thrown)).toBe(true);
    // The prompt was never delivered to the doomed session.
    expect(fake.commands().some((c) => c.type === 'prompt')).toBe(false);
    expect(events.some((e) => e.type === 'result')).toBe(false);
  });
});
