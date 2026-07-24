/**
 * Web channel — a locally hosted browser chat UI with native buttons and
 * properly rendered approval cards.
 *
 * A native `ChannelAdapter` (NOT the Chat SDK bridge). It hosts an HTTP + ws
 * server on 127.0.0.1:<port> (default 7890). The HTTP server serves a built
 * React SPA (src/channels/web-ui/dist); the WebSocket carries the live
 * conversation both ways. Designed arch-neutral (plain Node + ws) so it runs
 * unchanged on x86 and ARM64 (the DGX Spark target).
 *
 * Approval cards: outbound `ask_question` payloads render as real cards with
 * option buttons. Button ids are encoded `ncq:<questionId>:<optionIndex>`,
 * byte-for-byte the same encoding the Chat SDK bridge uses
 * (src/channels/chat-sdk-bridge.ts, deliver() `Button({ id: ... })` and
 * onAction()), so the host's approval plumbing works unchanged: on click the
 * adapter resolves the index back to the option value and invokes
 * `ChannelSetup.onAction(questionId, selectedOption, userId)`.
 *
 * Auth: a single shared token (env `NANOCLAW_WEB_TOKEN`, else auto-generated
 * and persisted to `<DATA_DIR>/web-channel-token`). The browser presents it
 * once on the WebSocket upgrade (`/ws?token=...`); compared in constant time.
 * The token is never written to logs.
 *
 * Single-user demo grade. Bind stays 127.0.0.1; expose via SSH/tailscale tunnel.
 */
import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { fileURLToPath } from 'url';

import { WebSocketServer, type WebSocket } from 'ws';

import { log } from '../log.js';
import { normalizeOptions, type NormalizedOption } from './ask-question.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'web';
const PLATFORM_ID = 'local';
const DEFAULT_PORT = 7890;
const DEFAULT_HOST = '127.0.0.1';

/**
 * The web UI is a browser: every message the operator types is for the agent
 * (pattern '.'), the shared token gates access so senders are trusted
 * ('public'), there is no thread or platform-mention concept (DMs only).
 * Mirrors the CLI adapter's stance (src/channels/cli.ts CLI_DEFAULTS).
 */
const WEB_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'public' },
  mentions: 'never',
};

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
};

/**
 * Resolve a clicked button back to its option value. Copied verbatim from
 * the Chat SDK bridge (chat-sdk-bridge.ts resolveSelectedOption) so the two
 * paths agree: new format = the button carries the integer option index;
 * old/degenerate format = the value is passed through untouched.
 */
function resolveSelectedOption(render: { options: NormalizedOption[] } | undefined, candidate: string): string {
  if (render && /^\d+$/.test(candidate)) {
    const idx = Number(candidate);
    if (render.options[idx]) return render.options[idx].value;
  }
  return candidate;
}

/** Constant-time token compare that tolerates length mismatch without leaking it. */
function tokenMatches(expected: string, presented: string | null): boolean {
  if (!presented) return false;
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(presented, 'utf8');
  if (a.length !== b.length) {
    // Still burn a comparison against a fixed-size buffer so timing doesn't
    // reveal the length, then fail.
    crypto.timingSafeEqual(a, a);
    return false;
  }
  return crypto.timingSafeEqual(a, b);
}

/** Where the built SPA lives, relative to this module. */
function spaDir(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.join(here, 'web-ui', 'dist');
}

/** Resolve the shared token: env override, else persisted, else generate+persist. */
function resolveToken(dataDir: string): { token: string; generated: boolean } {
  const fromEnv = process.env.NANOCLAW_WEB_TOKEN;
  if (fromEnv && fromEnv.length > 0) return { token: fromEnv, generated: false };
  const file = path.join(dataDir, 'web-channel-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length > 0) return { token: existing, generated: false };
  } catch {
    // fall through to generate
  }
  const token = crypto.randomBytes(24).toString('base64url');
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(file, token + '\n', { mode: 0o600 });
  } catch (err) {
    log.warn('Could not persist web-channel token (continuing in-memory)', { err });
  }
  return { token, generated: true };
}

export interface WebChannelOptions {
  port?: number;
  host?: string;
  dataDir?: string;
  /** Override the served SPA directory (tests). Defaults to ./web-ui/dist. */
  staticDir?: string;
}

export function createWebAdapter(options: WebChannelOptions = {}): ChannelAdapter {
  const port = options.port ?? (Number(process.env.NANOCLAW_WEB_PORT) || DEFAULT_PORT);
  const host = options.host ?? DEFAULT_HOST;
  const dataDir = options.dataDir ?? path.join(process.cwd(), 'data');
  const staticRoot = options.staticDir ?? spaDir();
  const { token, generated } = resolveToken(dataDir);

  let server: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  const clients = new Set<WebSocket>();

  // Per-question render metadata, so a click can resolve its option index back
  // to the real value + selectedLabel (the native-adapter stand-in for the
  // host's getAskQuestionRender DB read).
  const renderStore = new Map<string, { title: string; options: NormalizedOption[]; messageId: string }>();

  // Every message/card id this adapter has handed back from deliver(), so an
  // operation:'edit' targeting an id we never produced can at least be logged
  // — the host is the source of truth for which id it stored, this is just a
  // sanity check on our side.
  const deliveredMessageIds = new Set<string>();

  // Bounded in-memory replay log — lets a reconnecting client rebuild the
  // conversation instead of showing a blank screen. Deliberately not
  // persisted: it lives in this closure, so it survives a teardown()+setup()
  // network bounce (same adapter instance) but not a process restart.
  // Transient frames (typing) are never recorded.
  const HISTORY_LIMIT = 200;
  const history: Record<string, unknown>[] = [];

  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${Date.now()}-${(seq++).toString(36)}`;

  function broadcast(frame: Record<string, unknown>): void {
    const data = JSON.stringify(frame);
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) {
        try {
          ws.send(data);
        } catch (err) {
          log.warn('Failed to send frame to a client', { err });
        }
      }
    }
  }

  /** Broadcast a frame AND append it to the replay history. */
  function emit(frame: Record<string, unknown>): void {
    history.push(frame);
    if (history.length > HISTORY_LIMIT) history.shift();
    broadcast(frame);
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${host}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, channel: CHANNEL_TYPE }));
      return;
    }

    if (pathname === '/') pathname = '/index.html';
    // Resolve within staticRoot and refuse traversal.
    const resolved = path.normalize(path.join(staticRoot, pathname));
    if (!resolved.startsWith(staticRoot)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    fs.readFile(resolved, (err, buf) => {
      if (err) {
        // SPA fallback: unknown non-asset routes get index.html.
        if (!path.extname(pathname)) {
          fs.readFile(path.join(staticRoot, 'index.html'), (e2, idx) => {
            if (e2) {
              res.writeHead(404);
              res.end('not built — run `npm run build` in src/channels/web-ui');
              return;
            }
            res.writeHead(200, { 'content-type': CONTENT_TYPES['.html'] });
            res.end(idx);
          });
          return;
        }
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const type = CONTENT_TYPES[path.extname(resolved)] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': type });
      res.end(buf);
    });
  }

  function handleClientFrame(raw: string, config: ChannelSetup): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      log.warn('Ignoring non-JSON frame from client');
      return;
    }

    if (msg.type === 'user_message' && typeof msg.text === 'string' && msg.text.length > 0) {
      void Promise.resolve(
        config.onInbound(PLATFORM_ID, null, {
          id: nextId('web'),
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content: { text: msg.text, sender: 'web', senderId: `${CHANNEL_TYPE}:${PLATFORM_ID}` },
          isMention: true,
          isGroup: false,
        }),
      ).catch((err) => log.error('onInbound threw', { err }));
      return;
    }

    if (msg.type === 'action' && typeof msg.actionId === 'string') {
      // Parse exactly like chat-sdk-bridge.ts onAction: `ncq:<qid>:<index>`.
      const actionId = msg.actionId;
      if (!actionId.startsWith('ncq:')) return;
      const parts = actionId.split(':');
      if (parts.length < 3) return;
      const questionId = parts[1];
      const tail = parts.slice(2).join(':');
      const userId = `${CHANNEL_TYPE}:${PLATFORM_ID}`;

      const render = renderStore.get(questionId);
      const selectedOption = resolveSelectedOption(render, tail);
      const matched = render?.options.find((o) => o.value === selectedOption);
      const selectedLabel = matched?.selectedLabel ?? selectedOption ?? '(clicked)';
      const selectedIndex = /^\d+$/.test(tail) ? Number(tail) : -1;

      // Edit the card in place to its terminal chosen state (removes buttons),
      // then dispatch onAction — mirroring the bridge's order.
      emit({ type: 'card_resolved', questionId, selectedIndex, selectedLabel, actor: 'you' });
      renderStore.delete(questionId);

      try {
        config.onAction(questionId, selectedOption, userId);
      } catch (err) {
        log.error('onAction threw', { err });
      }
      return;
    }
  }

  const adapter: ChannelAdapter = {
    name: 'web',
    channelType: CHANNEL_TYPE,
    supportsThreads: false,
    defaults: WEB_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      server = http.createServer((req, res) => serveStatic(req, res));
      wss = new WebSocketServer({ noServer: true });

      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', `http://${host}`);
        if (url.pathname !== '/ws') {
          socket.destroy();
          return;
        }
        if (!tokenMatches(token, url.searchParams.get('token'))) {
          // 4401 (app-level unauthorized) is what the SPA listens for.
          socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
          socket.destroy();
          return;
        }
        wss!.handleUpgrade(req, socket, head, (ws) => {
          clients.add(ws);
          log.info('Web client connected', { clients: clients.size });
          // Replay everything we remember BEFORE 'ready', so the SPA rebuilds
          // its conversation before it flips to the connected state — this is
          // what makes a reconnect (dropped socket, or the whole ws layer
          // bouncing) look seamless instead of blank.
          ws.send(JSON.stringify({ type: 'history', frames: history }));
          ws.send(JSON.stringify({ type: 'ready', threadId: null }));
          ws.on('message', (data) => handleClientFrame(data.toString('utf8'), config));
          ws.on('close', () => {
            clients.delete(ws);
            log.info('Web client disconnected', { clients: clients.size });
          });
          ws.on('error', (err) => log.warn('Web client socket error', { err }));
        });
      });

      await new Promise<void>((resolve, reject) => {
        server!.once('error', reject);
        server!.listen(port, host, () => {
          log.info('Web channel listening', {
            url: `http://${host}:${port}`,
            token: generated ? '(auto-generated — see data/web-channel-token)' : '(from env)',
          });
          resolve();
        });
      });
    },

    async teardown(): Promise<void> {
      for (const ws of clients) {
        try {
          ws.close();
        } catch {
          // best-effort
        }
      }
      clients.clear();
      if (wss) {
        await new Promise<void>((resolve) => wss!.close(() => resolve()));
        wss = null;
      }
      if (server) {
        await new Promise<void>((resolve) => server!.close(() => resolve()));
        server = null;
      }
    },

    isConnected(): boolean {
      return server !== null;
    },

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== PLATFORM_ID) return undefined;
      const content = (message.content ?? {}) as Record<string, unknown>;

      // In-place edit of a previously delivered message/card — mirrors the
      // Chat SDK bridge's operation:'edit' handling (chat-sdk-bridge.ts
      // deliver(), content.operation === 'edit' branch). The host is the one
      // tracking messageId (it stores whatever deliver() returned); we just
      // forward the new text under that id.
      if (content.operation === 'edit' && content.messageId) {
        const messageId = content.messageId as string;
        const text = (content.text as string) || (content.markdown as string) || '';
        if (!deliveredMessageIds.has(messageId)) {
          log.warn('Editing a message id this adapter never delivered — forwarding anyway', { messageId });
        }
        emit({ type: 'edit', id: messageId, content: text });
        return undefined;
      }

      // Approval / interactive card.
      if (content.type === 'ask_question' && content.questionId && content.options) {
        const questionId = content.questionId as string;
        const title = (content.title as string) ?? '';
        const question = (content.question as string) ?? '';
        if (!title) {
          log.error('ask_question missing required title — skipping delivery', { questionId });
          return undefined;
        }
        const options = normalizeOptions(content.options as never);
        const messageId = nextId('card');
        deliveredMessageIds.add(messageId);
        renderStore.set(questionId, { title, options, messageId });
        emit({
          type: 'card',
          id: messageId,
          questionId,
          title,
          question,
          // Encode the option index into the wire shape; the button's actionId
          // becomes `ncq:<questionId>:<index>` on the client, matching the
          // Chat SDK bridge's Button id encoding.
          options: options.map((opt, index) => ({
            index,
            label: opt.label,
            selectedLabel: opt.selectedLabel,
            value: opt.value,
            style: opt.style,
          })),
        });
        return messageId;
      }

      // Display card (send_card MCP tool) — a generic, non-interactive card.
      // Mirrors the Chat SDK bridge's `content.type === 'card'` branch
      // (chat-sdk-bridge.ts deliver(), ~L466-514 on origin/main — the
      // channels-branch bridge predates this feature, so main is the
      // authoritative shape). No callback buttons: only `url` actions render,
      // as plain links (send_card's contract is fire-and-forget).
      if (content.type === 'card' && content.card && typeof content.card === 'object') {
        const cardSpec = content.card as Record<string, unknown>;
        const title = (cardSpec.title as string) || '';
        const description = (cardSpec.description as string) || '';

        const body: string[] = [];
        if (description) body.push(description);
        if (Array.isArray(cardSpec.children)) {
          for (const child of cardSpec.children) {
            if (typeof child === 'string' && child) {
              body.push(child);
            } else if (
              child &&
              typeof child === 'object' &&
              typeof (child as Record<string, unknown>).text === 'string'
            ) {
              body.push((child as Record<string, string>).text);
            }
          }
        }

        const links: Array<{ label: string; url: string; style?: NormalizedOption['style'] }> = [];
        if (Array.isArray(cardSpec.actions)) {
          for (const action of cardSpec.actions as Array<Record<string, unknown>>) {
            if (typeof action.url === 'string' && action.url && typeof action.label === 'string' && action.label) {
              const style = action.style;
              links.push({
                label: action.label,
                url: action.url,
                style: style === 'primary' || style === 'danger' || style === 'default' ? style : undefined,
              });
            }
          }
        }

        const fallbackText = (content.fallbackText as string) || description || title || '';

        if (body.length === 0 && links.length === 0 && !title) {
          if (fallbackText) {
            // Nothing structured to render, but the producer gave us a
            // fallback string — show it as a plain message rather than
            // silently dropping the delivery (deliberate divergence from the
            // bridge, which drops here unconditionally).
            const messageId = nextId('msg');
            deliveredMessageIds.add(messageId);
            emit({ type: 'message', id: messageId, role: 'assistant', content: fallbackText });
            return messageId;
          }
          log.warn('send_card payload empty, skipping delivery');
          return undefined;
        }

        const messageId = nextId('gcard');
        deliveredMessageIds.add(messageId);
        emit({ type: 'generic_card', id: messageId, title, body, links, fallbackText });
        return messageId;
      }

      // Typing off — a real message supersedes any streaming indicator.
      broadcast({ type: 'typing', on: false });

      // Normal message — prefer markdown, fall back to text (mirrors the
      // bridge's rawText = content.markdown || content.text).
      const text = (content.markdown as string) || (content.text as string);
      if (text) {
        const messageId = nextId('msg');
        deliveredMessageIds.add(messageId);
        emit({ type: 'message', id: messageId, role: 'assistant', content: text });
        return messageId;
      }
      return undefined;
    },

    async setTyping(platformId): Promise<void> {
      if (platformId !== PLATFORM_ID) return;
      broadcast({ type: 'typing', on: true });
    },
  };

  return adapter;
}

// Self-register when imported as a channel module (host side-effect import),
// mirroring cli.ts's registerChannelAdapter('cli', ...) at the foot of the file.
// The factory takes no creds, so it never returns null. `defaults` is the same
// const the adapter reports, resolvable offline by ncl/setup without spawning.
registerChannelAdapter('web', { factory: () => createWebAdapter(), defaults: WEB_DEFAULTS });

export const WEB_CHANNEL_DEFAULTS = WEB_DEFAULTS;
