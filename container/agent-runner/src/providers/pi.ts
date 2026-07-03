import { spawn } from 'child_process';
import { randomUUID } from 'crypto';
import path from 'path';
import { StringDecoder } from 'string_decoder';

import { registerProvider } from './provider-registry.js';
import type {
  AgentProvider,
  AgentQuery,
  McpServerConfig,
  ProviderEvent,
  ProviderOptions,
  QueryInput,
} from './types.js';

function log(msg: string): void {
  console.error(`[pi-provider] ${msg}`);
}

/**
 * Grace period between SIGTERM and the SIGKILL fallback when tearing the
 * subprocess down. Operator-overridable for slow shutdowns.
 */
function graceMs(): number {
  return Number(process.env.PI_KILL_GRACE_MS) || 2000;
}

/**
 * Session-storage root for pi's own JSONL transcripts. Env-overridable so a
 * deployment can point it at a persistent volume; the default mirrors how the
 * Claude provider keeps state under the agent's home.
 */
function piSessionDir(): string {
  return process.env.PI_SESSION_DIR || path.join(process.env.HOME || '/home/node', '.pi', 'sessions');
}

/**
 * pi's own session-id constraint (verified in the dist: `main.js` validates
 * ids against this exact pattern). `crypto.randomUUID()` satisfies it.
 */
const SESSION_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function isValidSessionId(id: string | undefined): id is string {
  return typeof id === 'string' && SESSION_ID_RE.test(id);
}

/**
 * Stale/invalid-session detection. pi never emits this itself on the
 * `--session-id` path: an unknown id silently falls through to
 * `SessionManager.create()` and starts a fresh empty session (verified
 * against pi 0.80.3 — the "No session found matching" string only fires on
 * the --fork/--session fuzzy-resolve paths in `main.js`). So the provider
 * detects the condition itself: when resuming a continuation it issues
 * `get_state` and, if the session reports zero messages, surfaces an error
 * crafted to match this regex so the runner's clear-continuation →
 * fresh-start path engages.
 */
const STALE_SESSION_RE = /no session found matching|invalid session/i;

/**
 * Translate an `ProviderOptions.model` value into pi CLI flags. A value with a
 * slash is split on the FIRST slash into `--provider <head> --model <tail>`;
 * anything else is passed whole as `--model`. Omitted when unset.
 */
export function buildModelArgs(model: string | undefined): string[] {
  if (!model) return [];
  const slash = model.indexOf('/');
  if (slash === -1) return ['--model', model];
  return ['--provider', model.slice(0, slash), '--model', model.slice(slash + 1)];
}

function buildPiArgs(
  sessionId: string,
  sessionDir: string,
  model: string | undefined,
  instructions: string | undefined,
): string[] {
  const args = [
    '--mode',
    'rpc',
    '--session-id',
    sessionId,
    '--session-dir',
    sessionDir,
    '--no-extensions',
    ...buildModelArgs(model),
  ];
  if (instructions) args.push('--append-system-prompt', instructions);
  return args;
}

function mergeEnv(
  base: NodeJS.ProcessEnv,
  extra: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined) out[k] = v;
  }
  for (const [k, v] of Object.entries(extra)) {
    if (v === undefined) delete out[k];
    else out[k] = v;
  }
  return out;
}

// ── JSONL framing ──

export interface JsonlReader {
  write(chunk: Buffer | string): void;
  end(): void;
}

/**
 * Strict-JSONL reader for pi's stdout. Records are delimited by LF only; a
 * trailing CR is stripped. Deliberately hand-rolled instead of Node
 * `readline`, which also splits on U+2028/U+2029 — both valid inside JSON
 * strings — and would corrupt event payloads containing those characters.
 */
export function createJsonlReader(onLine: (line: string) => void): JsonlReader {
  let buffer = '';
  const decoder = new StringDecoder('utf8');
  return {
    write(chunk: Buffer | string): void {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk);
      let idx: number;
      while ((idx = buffer.indexOf('\n')) !== -1) {
        let line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        onLine(line);
      }
    },
    end(): void {
      buffer += decoder.end();
      if (buffer.length > 0) {
        onLine(buffer.endsWith('\r') ? buffer.slice(0, -1) : buffer);
        buffer = '';
      }
    },
  };
}

// ── Event translation ──

interface PiAssistantMessageEvent {
  type?: string;
  delta?: string;
  reason?: string;
}

interface PiMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
}

interface PiEvent {
  type?: string;
  assistantMessageEvent?: PiAssistantMessageEvent;
  message?: PiMessage;
  messages?: PiMessage[];
  errorMessage?: string;
  finalError?: string;
  success?: boolean;
}

export interface PiTranslateState {
  /** Assistant text accumulated for the in-flight exchange. */
  text: string;
  /** Set once the current exchange has surfaced an error (suppresses result). */
  errored: boolean;
}

export function newTranslateState(): PiTranslateState {
  return { text: '', errored: false };
}

function extractAssistantText(msg: PiMessage | null | undefined): string {
  if (!msg || msg.role !== 'assistant') return '';
  const content = msg.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === 'object' && b !== null && (b as { type?: string }).type === 'text' && typeof (b as { text?: unknown }).text === 'string',
      )
      .map((b) => b.text)
      .join('');
  }
  return '';
}

function lastAssistant(messages: PiMessage[] | undefined): PiMessage | null {
  if (!Array.isArray(messages)) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.role === 'assistant') return messages[i];
  }
  return null;
}

/**
 * Map one pi stdout event to zero or more ProviderEvents. Every event yields a
 * leading `activity` so the poll-loop's idle timer stays honest. `state` is
 * mutated to accumulate the exchange's assistant text and error status across
 * calls; reset it (or send `agent_start`) between exchanges.
 */
export function translatePiEvent(event: PiEvent, state: PiTranslateState): ProviderEvent[] {
  const out: ProviderEvent[] = [{ type: 'activity' }];

  switch (event.type) {
    case 'agent_start':
      state.text = '';
      state.errored = false;
      break;

    case 'message_update': {
      const ame = event.assistantMessageEvent;
      if (ame?.type === 'text_delta' && typeof ame.delta === 'string') {
        state.text += ame.delta;
      } else if (ame?.type === 'error') {
        state.errored = true;
        out.push({ type: 'error', message: `pi message error: ${ame.reason ?? 'error'}`, retryable: false });
      }
      break;
    }

    case 'message_end':
    case 'turn_end': {
      const text = extractAssistantText(event.message);
      if (text) state.text = text;
      if (event.message?.stopReason === 'error' && !state.errored) {
        state.errored = true;
        out.push({ type: 'error', message: 'pi turn ended with an error', retryable: false });
      }
      break;
    }

    case 'agent_end': {
      const finalText = extractAssistantText(lastAssistant(event.messages)) || state.text;
      if (!state.errored) out.push({ type: 'result', text: finalText || null });
      break;
    }

    case 'auto_retry_start':
      out.push({ type: 'error', message: event.errorMessage || 'pi auto-retry', retryable: true });
      break;

    case 'auto_retry_end':
      if (event.success === false) {
        out.push({ type: 'error', message: event.finalError || 'pi auto-retry failed', retryable: true });
      }
      break;

    default:
      break;
  }

  return out;
}

// ── Subprocess plumbing (injectable for tests) ──

export interface ChildProcessLike {
  stdin: { write(data: string): unknown; end?(): void } | null;
  stdout: { on(event: string, cb: (chunk: Buffer | string) => void): unknown } | null;
  stderr: { on(event: string, cb: (chunk: Buffer | string) => void): unknown } | null;
  on(event: 'exit', cb: (code: number | null, signal: string | null) => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
  kill(signal?: NodeJS.Signals | number): boolean;
}

export interface PiRuntimeDeps {
  spawn: (command: string, args: string[], options: { cwd: string; env: Record<string, string> }) => ChildProcessLike;
  generateSessionId: () => string;
}

const defaultRuntime: PiRuntimeDeps = {
  spawn: (command, args, options) =>
    spawn(command, args, { cwd: options.cwd, env: options.env, stdio: ['pipe', 'pipe', 'pipe'] }) as unknown as ChildProcessLike,
  generateSessionId: () => randomUUID(),
};

const DIALOG_UI_METHODS = new Set(['select', 'confirm', 'input', 'editor']);

// ── Provider ──

export class PiProvider implements AgentProvider {
  readonly supportsNativeSlashCommands = false;
  // pi has no native NanoClaw memory — opt in to the runner's persistent
  // `memory/` scaffold. pi keeps its own JSONL transcript, so no
  // onExchangeComplete / maybeRotateContinuation.
  readonly usesMemoryScaffold = true;

  private readonly mcpServers: Record<string, McpServerConfig>;
  private readonly env: Record<string, string | undefined>;
  private readonly model?: string;
  private readonly runtime: PiRuntimeDeps;

  constructor(options: ProviderOptions = {}, runtime: PiRuntimeDeps = defaultRuntime) {
    this.mcpServers = options.mcpServers ?? {};
    this.env = options.env ?? {};
    this.model = options.model;
    this.runtime = runtime;
  }

  isSessionInvalid(err: unknown): boolean {
    const msg = err instanceof Error ? err.message : String(err);
    return STALE_SESSION_RE.test(msg);
  }

  query(input: QueryInput): AgentQuery {
    const mcpCount = Object.keys(this.mcpServers).length;
    if (mcpCount > 0) {
      log(`pi has no MCP support; ignoring ${mcpCount} configured MCP server(s)`);
    }

    const sessionId = isValidSessionId(input.continuation) ? input.continuation : this.runtime.generateSessionId();
    const args = buildPiArgs(sessionId, piSessionDir(), this.model, input.systemContext?.instructions);
    const child = this.runtime.spawn('pi', args, {
      cwd: input.cwd,
      env: mergeEnv(process.env, this.env),
    });

    const state = newTranslateState();
    const buffer: ProviderEvent[] = [];
    let waker: (() => void) | null = null;
    let done = false;
    let aborted = false;
    let ended = false;
    let streaming = false;
    let terminating = false;
    let exitError: Error | null = null;
    let killTimer: ReturnType<typeof setTimeout> | null = null;
    // Resume liveness check: `--session-id` with an unknown id silently
    // creates a fresh empty session, so a resumed continuation must be
    // verified via get_state before the first prompt is sent. Prompts pushed
    // while the check is pending are deferred.
    const resuming = isValidSessionId(input.continuation);
    let awaitingStateCheck = resuming;
    const deferredPrompts: string[] = [];

    const kick = (): void => {
      waker?.();
      waker = null;
    };

    const writeCmd = (obj: Record<string, unknown>): void => {
      try {
        child.stdin?.write(JSON.stringify(obj) + '\n');
      } catch (err) {
        log(`stdin write failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    const sendPrompt = (message: string): void => {
      streaming = true;
      writeCmd({ type: 'prompt', message });
    };

    const sendSteer = (message: string): void => {
      writeCmd({ type: 'steer', message });
    };

    const terminate = (): void => {
      if (terminating) return;
      terminating = true;
      try {
        child.stdin?.end?.();
      } catch {
        /* ignore */
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* ignore */
        }
      }, graceMs());
      killTimer.unref?.();
    };

    const handleResponse = (event: { success?: boolean; command?: string; error?: string; data?: unknown }): void => {
      if (event.command === 'get_state' && awaitingStateCheck) {
        awaitingStateCheck = false;
        // `data.messageCount` is `session.messages.length` in pi's RPC mode
        // (dist/modes/rpc/rpc-mode.js). Zero messages under a supplied
        // continuation means the backing transcript is gone — pi silently
        // created a fresh session in its place. Kill it and surface a
        // stale-session error so the runner clears the continuation.
        const messageCount = (event.data as { messageCount?: number } | undefined)?.messageCount;
        if (event.success !== false && messageCount === 0) {
          exitError = new Error(`No session found matching '${sessionId}'`);
          log(`resumed session '${sessionId}' has 0 messages — backing transcript is gone; restarting fresh`);
          terminate();
          kick();
          return;
        }
        if (event.success === false) {
          // Fail open: an unexpected get_state failure shouldn't block the
          // exchange; proceed and let the prompt path surface real errors.
          log(`[response-error] get_state failed (${event.error ?? 'unknown'}); proceeding without resume check`);
        }
        for (const p of deferredPrompts.splice(0)) sendPrompt(p);
        kick();
        return;
      }
      if (event.success === false) {
        const err = String(event.error ?? 'pi command failed');
        log(`[response-error] command=${event.command ?? '?'}: ${err}`);
        if (STALE_SESSION_RE.test(err)) {
          exitError = new Error(err);
          terminate();
        } else {
          buffer.push({ type: 'error', message: err, retryable: false });
          kick();
        }
      }
    };

    const handleExtensionUi = (event: { id?: unknown; method?: string }): void => {
      // Belt-and-braces: we launch with --no-extensions, but auto-cancel any
      // dialog request so a stray extension can never block the turn.
      if (event.id != null && typeof event.method === 'string' && DIALOG_UI_METHODS.has(event.method)) {
        writeCmd({ type: 'extension_ui_response', id: event.id, cancelled: true });
      }
    };

    const onLine = (line: string): void => {
      if (!line.trim()) return;
      let event: PiEvent & { command?: string; error?: string; id?: unknown; method?: string };
      try {
        event = JSON.parse(line);
      } catch {
        log(`[parse-error] ${line.slice(0, 200)}`);
        return;
      }

      if (event.type === 'response') {
        handleResponse(event);
        return;
      }
      if (event.type === 'extension_ui_request') {
        handleExtensionUi(event);
        buffer.push({ type: 'activity' });
        kick();
        return;
      }

      for (const e of translatePiEvent(event, state)) buffer.push(e);
      if (event.type === 'agent_start') streaming = true;
      if (event.type === 'agent_end') {
        streaming = false;
        if (ended) terminate();
      }
      kick();
    };

    const reader = createJsonlReader(onLine);
    child.stdout?.on('data', (chunk) => reader.write(chunk));
    child.stdout?.on('end', () => reader.end());
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString().trim();
      if (text) log(`[stderr] ${text}`);
    });

    child.on('exit', (code, signal) => {
      if (killTimer) clearTimeout(killTimer);
      if (done) return;
      if (!aborted && !terminating && code !== 0 && code !== null) {
        exitError = new Error(`pi exited: code=${code} signal=${signal}`);
        buffer.push({ type: 'error', message: exitError.message, retryable: false });
      }
      done = true;
      kick();
    });

    child.on('error', (err) => {
      if (killTimer) clearTimeout(killTimer);
      if (done) return;
      exitError = err;
      buffer.push({ type: 'error', message: err.message, retryable: false });
      done = true;
      kick();
    });

    async function* gen(): AsyncGenerator<ProviderEvent> {
      buffer.push({ type: 'init', continuation: sessionId });
      if (awaitingStateCheck) {
        deferredPrompts.push(input.prompt);
        writeCmd({ type: 'get_state' });
      } else {
        sendPrompt(input.prompt);
      }
      try {
        while (true) {
          while (buffer.length > 0) {
            if (aborted) return;
            yield buffer.shift()!;
          }
          if (aborted) return;
          if (done) break;
          await new Promise<void>((resolve) => {
            waker = resolve;
          });
          waker = null;
        }
        while (buffer.length > 0 && !aborted) yield buffer.shift()!;
        if (exitError && !aborted) throw exitError;
      } finally {
        if (killTimer) clearTimeout(killTimer);
        terminate();
      }
    }

    return {
      push: (message) => {
        if (awaitingStateCheck) deferredPrompts.push(message);
        else if (streaming) sendSteer(message);
        else sendPrompt(message);
      },
      end: () => {
        ended = true;
        // Don't tear down while the resume check or a deferred prompt is
        // still pending — the flushed prompt's agent_end triggers teardown.
        if (!streaming && !awaitingStateCheck && deferredPrompts.length === 0) terminate();
        kick();
      },
      abort: () => {
        aborted = true;
        writeCmd({ type: 'abort' });
        terminate();
        kick();
      },
      events: gen(),
    };
  }
}

registerProvider('pi', (opts) => new PiProvider(opts));
