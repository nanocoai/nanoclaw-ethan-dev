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
 * Tailscale identity (opt-in, env `NANOCLAW_WEB_TRUST_TAILSCALE=1`): in
 * production this adapter sits behind `tailscale serve`, which authenticates
 * the tailnet peer itself and injects a verified `Tailscale-User-Login`
 * header into every proxied request. With the opt-in set, a request carrying
 * a non-empty such header is authenticated WITHOUT a token, and that login
 * (e.g. `someone@example.com`) becomes the connection's userId — reported
 * back in the `ready` frame and in the connection log line. The token keeps
 * working as a fallback (probe scripts, proof harnesses, setups with no
 * `tailscale serve` in front), and takes precedence when both are present.
 * With the opt-in UNSET the header is ignored entirely and behavior is
 * byte-for-byte the token-only behavior that predates this feature. See
 * authenticate() for the single shared decision every entry point uses.
 *
 * Accepted caveat, demo grade: with the opt-in set, anything that can reach
 * this loopback listener directly (bypassing `tailscale serve`) can forge the
 * header and authenticate as any login. That is accepted here because local
 * processes on this host are all-trusted and default-bridge containers cannot
 * reach host loopback; it must be revisited in the multi-user hardening pass,
 * where the fix is to verify the proxy hop rather than the header alone.
 * The header path never weakens the token path: the constant-time token
 * compare runs first and unchanged, and the header is only ever consulted
 * under the explicit env opt-in.
 *
 * Sessions (WU3): the UI shows several conversations in a sidebar, and one UI
 * conversation IS one `threadId`. The host already keys agent sessions on
 * (messaging_group_id, thread_id) and routes replies back through
 * `deliver(platformId, threadId, ...)`, so passing a real per-conversation id
 * out of `onInbound` — instead of the `null` this adapter used to pass — buys
 * a distinct agent session (own continuation, own container lifecycle) per UI
 * conversation with no core changes. `supportsThreads` therefore has to be
 * true here: the router hard-strips thread ids from adapters that declare it
 * false (src/router.ts), and the effective policy is
 * (wiring ?? channelDefaults).threads AND supportsThreads
 * (src/channels/channel-defaults.ts resolveThreadPolicy) — which is why the
 * declared defaults below carry `threads: true` in both dm and group.
 *
 * Replay history: every recorded frame is also mirrored to
 * `<DATA_DIR>/web-channel-history/<sessionId>.jsonl` (append-only,
 * periodically compacted, one file per session) so a process restart still
 * has conversations to replay, not just a teardown()+setup() bounce in the
 * same process — see the session-registry comments below for the per-session
 * seq-monotonicity guarantee this relies on. A pre-WU3 single
 * `<DATA_DIR>/web-channel-history.jsonl` is adopted once, on boot, as the
 * session `default`. Attachment BYTES are never persisted this way — see the
 * `files` map comment.
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
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundFile, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'web';
const PLATFORM_ID = 'local';
const DEFAULT_PORT = 7890;
const DEFAULT_HOST = '127.0.0.1';

// The header `tailscale serve` injects on every proxied request, carrying the
// tailnet login it verified for the calling peer. Lowercase because Node
// normalizes incoming header names that way in `req.headers`.
const TAILSCALE_LOGIN_HEADER = 'tailscale-user-login';

// Half-open-socket detection (found in a reboot drill: a server restart
// leaves a connected browser tab on a TCP socket that never gets a close
// event — no FIN/RST arrives, so the tab just sits there looking connected
// and hearing nothing until the tab is manually refreshed). Two independent
// mechanisms, one per direction:
//  - protocol-level ping/pong (standard `ws` isAlive pattern below): lets the
//    SERVER notice a dead client and terminate() the socket.
//  - an app-level heartbeat frame broadcast on the same interval: browsers
//    cannot observe protocol-level pings from JS, so the CLIENT instead runs
//    a deadman timer reset by any incoming frame (see useNanoclaw.ts) and
//    force-closes itself if nothing — not even a heartbeat — arrives in time.
const HEARTBEAT_INTERVAL_MS = 30000;

/**
 * The web UI is a browser: every message the operator types is for the agent
 * (pattern '.'), the shared token gates access so senders are trusted
 * ('public'), there is no platform-mention concept (DMs only). Mirrors the
 * CLI adapter's stance (src/channels/cli.ts CLI_DEFAULTS), except for
 * threads: WU3 makes one sidebar conversation one thread, so both contexts
 * declare `threads: true`. The declaration is only half the policy —
 * resolveThreadPolicy() ANDs it with `supportsThreads` (true below) and with
 * the per-wiring `messaging_group_agents.threads` override, so an existing
 * wiring that persisted `threads = 0` while this channel was non-threaded
 * keeps collapsing threads until that row is updated.
 */
const WEB_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: true, unknownSenderPolicy: 'public' },
  mentions: 'never',
};

// ---- Sessions (WU3) ----
//
// A session id is also a threadId (it crosses the adapter contract into the
// host) AND a filename (`<sessionId>.jsonl` under the history dir), so it is
// validated on every path that can receive one from outside this module: a
// client op, a `deliver()` threadId, a filename found while rebuilding the
// index. Anything failing this pattern is refused rather than sanitized —
// there is no legitimate producer of such an id, and "sanitize it into
// something valid" is how a `../` gets written to a file the adapter never
// meant to touch.
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

/** The id a pre-WU3 single-file history is adopted under, exactly once, on boot. */
const LEGACY_SESSION_ID = 'default';

/** Titles are the first user message, openwebui-style, truncated for the sidebar. */
const SESSION_TITLE_MAX = 60;

function isValidSessionId(id: unknown): id is string {
  return typeof id === 'string' && SESSION_ID_PATTERN.test(id);
}

function sessionTitleFrom(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= SESSION_TITLE_MAX) return clean;
  return clean.slice(0, SESSION_TITLE_MAX - 1).trimEnd() + '…';
}

/** Metadata the sidebar renders and `index.json` persists. Never holds frames. */
interface SessionMeta {
  id: string;
  /** Empty until the session's first user message names it; the SPA shows "New chat" for that. */
  title: string;
  createdAt: number;
  lastActiveAt: number;
}

/** One live conversation: its metadata plus the same bounded ring + seq counter the single-conversation adapter used to keep globally. */
interface SessionState {
  meta: SessionMeta;
  history: Record<string, unknown>[];
  /** Per-session monotonic frame counter — see emit(). Restored from disk at cold start. */
  frameSeq: number;
  linesOnDisk: number;
}

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
  '.webmanifest': 'application/manifest+json',
};

// P2a outbound attachments. OutboundFile (adapter.ts) carries only
// `{ filename, data }` — no mime type — so it's derived here from the
// extension. Anything not in this table serves as application/octet-stream:
// a deliberately safe default (never lets an attachment's filename extension
// (e.g. a model-authored .html/.svg) get inline-rendered as a browser
// document; the SPA only ever treats `image/*` specially, see
// components/AttachmentRow.tsx).
const ATTACHMENT_MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.md': 'text/plain',
  '.csv': 'text/csv',
  '.log': 'text/plain',
  '.zip': 'application/zip',
};

function mimeForFilename(filename: string): string {
  const ext = path.extname(filename).toLowerCase();
  return ATTACHMENT_MIME_TYPES[ext] ?? 'application/octet-stream';
}

/**
 * RFC 6266-ish Content-Disposition: a quoted-string fallback (backslash/quote
 * escaped) plus a UTF-8 `filename*` for names outside ASCII — good enough for
 * the browsers this single-user demo actually needs to support.
 */
function contentDispositionHeader(filename: string, disposition: 'attachment' | 'inline' = 'attachment'): string {
  const quoted = filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const encoded = encodeURIComponent(filename).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return `${disposition}; filename="${quoted}"; filename*=UTF-8''${encoded}`;
}

/**
 * Mimes allowed to render as a browser DOCUMENT when the client asks for
 * ?inline=1 on a download. Without this opt-in every /files/ response is
 * `Content-Disposition: attachment`, which makes an "open in new tab" link
 * useless — the browser downloads instead of displaying (found live: clicking
 * "open" on a non-inline-eligible upload just re-downloaded it). Deny by
 * default: html/svg/xml stay attachment-only forever — a model- or
 * user-authored document executing under this origin is the exact thing the
 * octet-stream default exists to prevent.
 */
function mimeSafeForInlineDisposition(mime: string): boolean {
  if (mime === 'text/html' || mime === 'image/svg+xml' || mime.includes('xml')) return false;
  return (
    mime.startsWith('image/') || mime.startsWith('text/') || mime === 'application/pdf' || mime === 'application/json'
  );
}

/** One outbound file, registered under an opaque random id. Never a filesystem path — `data` is the buffer OutboundFile already carries in memory. */
interface RegisteredFile {
  id: string;
  filename: string;
  mime: string;
  size: number;
  data: Buffer;
}

// Bounded like the history ring (HISTORY_LIMIT below): evict the OLDEST file
// once either cap is exceeded. An evicted id answers 410 Gone (it existed,
// it's just gone) rather than 404 (never existed) — the SPA tells the two
// apart (AttachmentRow.tsx "no longer available" state, either way).
const FILE_COUNT_LIMIT = 50;
const FILE_BYTES_LIMIT = 100 * 1024 * 1024;

// ---- Files-IN (upload) ----
//
// A hand-rolled multipart/form-data reader — deliberately not a dependency
// (busboy/multer/formidable): this file's whole design point is "arch-neutral,
// plain Node + ws" (see the file header), and the parsing this single-user
// demo needs (a handful of small parts, no streaming-to-disk) is a couple
// hundred lines, not a reason to pull in a body-parsing framework.
const MAX_FILE_BYTES = 25 * 1024 * 1024; // ~25MB/file
const MAX_FILES_PER_MESSAGE = 5;
// Multipart framing (boundaries, headers) adds overhead on top of the raw
// file bytes; this cap is checked BEFORE parsing (both against the
// Content-Length header and while streaming the body in) so an oversized
// request is rejected without ever buffering MAX_FILES_PER_MESSAGE full-size
// files in memory just to find out it's too big.
const MAX_UPLOAD_BODY_BYTES = MAX_FILES_PER_MESSAGE * MAX_FILE_BYTES + 2 * 1024 * 1024;

class UploadError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

/**
 * Mime types trusted straight from the browser's multipart Content-Type for
 * an uploaded part. Deliberately the same safety stance as outbound files
 * (ATTACHMENT_MIME_TYPES above): an upload's reported Content-Type is
 * attacker-influenceable (FormData lets JS set an arbitrary `type` on a
 * File/Blob independent of its actual bytes or extension), so anything NOT
 * on this allow-list — e.g. `image/svg+xml`, which the SPA would otherwise
 * happily inline as `<img>` and which can carry a `<script>` — falls back to
 * the same extension-derived mimeForFilename() the outbound path uses.
 */
const ALLOWED_UPLOAD_MIME_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'application/pdf',
  'application/json',
  'text/plain',
  'text/csv',
  'application/zip',
]);

function sanitizeUploadMime(reported: string | undefined, filename: string): string {
  const clean = (reported ?? '').split(';')[0].trim().toLowerCase();
  if (clean && ALLOWED_UPLOAD_MIME_TYPES.has(clean)) return clean;
  return mimeForFilename(filename);
}

function parseMultipartBoundary(contentType: string | undefined): string {
  const match = /boundary="?([^";]+)"?/i.exec(contentType ?? '');
  if (!match) throw new UploadError(400, 'missing multipart boundary');
  return match[1];
}

interface MultipartPart {
  /** The form field name (`name="..."` in Content-Disposition). */
  name: string;
  /** Present only for file parts (`filename="..."`); empty for plain fields. */
  filename: string;
  contentType: string;
  data: Buffer;
}

/**
 * Minimal multipart/form-data reader: split on the boundary, then split each
 * part's headers from its body on the first blank line. Safe for binary file
 * data because the boundary search runs on the raw Buffer (never a string
 * conversion of the whole body) — only each part's HEADER block is decoded
 * as text, the body bytes are sliced straight out of the original buffer.
 * Relies on the boundary itself being long and random enough never to
 * collide with a file's actual bytes — true of every browser-generated
 * FormData boundary, which is what this endpoint is built for.
 */
function parseMultipart(body: Buffer, boundary: string): MultipartPart[] {
  const boundaryMarker = Buffer.from(`--${boundary}`);
  const parts: MultipartPart[] = [];
  let start = body.indexOf(boundaryMarker);
  while (start !== -1) {
    const nextStart = body.indexOf(boundaryMarker, start + boundaryMarker.length);
    if (nextStart === -1) break; // no further boundary — `start` was the closing `--boundary--`
    let partBuf = body.subarray(start + boundaryMarker.length, nextStart);
    if (partBuf.subarray(0, 2).toString('latin1') === '\r\n') partBuf = partBuf.subarray(2);
    if (partBuf.subarray(-2).toString('latin1') === '\r\n') partBuf = partBuf.subarray(0, -2);

    const headerEnd = partBuf.indexOf('\r\n\r\n');
    if (headerEnd !== -1) {
      const headerStr = partBuf.subarray(0, headerEnd).toString('utf8');
      const data = partBuf.subarray(headerEnd + 4);
      const nameMatch = /name="([^"]*)"/.exec(headerStr);
      const filenameMatch = /filename="([^"]*)"/.exec(headerStr);
      const contentTypeMatch = /Content-Type:\s*([^\r\n]+)/i.exec(headerStr);
      if (nameMatch) {
        // Undo the backslash-escaping browsers apply to `"` / `\` inside a
        // quoted Content-Disposition parameter (mirrors
        // contentDispositionHeader's own escaping on the way out).
        const unescape = (s: string) => s.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
        parts.push({
          name: unescape(nameMatch[1]),
          filename: filenameMatch ? unescape(filenameMatch[1]) : '',
          contentType: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
          data,
        });
      }
    }
    start = nextStart;
  }
  return parts;
}

/** Read the whole request body, aborting (rejecting) the moment it exceeds `capBytes` — never buffers past the cap. */
function readBodyCapped(req: http.IncomingMessage, capBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > capBytes) {
        req.destroy();
        reject(new UploadError(413, 'upload too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', (err) => reject(err));
  });
}

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

// P2b stale-bundle detection. Real incident (twice in one day): a browser tab
// left open across a server deploy keeps running the OLD SPA bundle, then the
// new server starts sending frame shapes that bundle doesn't know about
// (role:user echoes rendered as duplicates once; a `file` frame silently not
// rendered another time). Cache headers (no-store on index.html, above) fix a
// plain reload but can't reach a tab that's already open and never reloads.
//
// Fix: read the SPA's own build fingerprint straight off the served
// index.html's hashed entry script (e.g. `index-BCC2gOvE.js`) and hand it to
// every connecting client in the `ready` frame as `bundle`. Deliberately NOT
// a hand-bumped constant — those rot the moment someone forgets to bump them
// (this repo's own history: the cache-header fix earlier today was needed
// because staleness detection had no signal at all). The SPA compares this
// against its own script tag at connect time (useNanoclaw.ts) and reloads
// itself once if they disagree.
function readBundleFingerprint(dir: string): string | undefined {
  try {
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    // Matches the vite-built <script type="module" src="./assets/index-HASH.js">
    // tag verbatim — same shape the SPA itself parses out of its own DOM.
    const match = html.match(/<script[^>]+\ssrc="[^"]*\/(index-[^"/]+\.js)"/);
    return match?.[1];
  } catch {
    return undefined;
  }
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
  /**
   * Override the `bundle` fingerprint reported in the `ready` frame
   * (tests/harness only — real production always computes this from the
   * served SPA's own index.html, see readBundleFingerprint()). `null` means
   * "omit the field entirely", simulating a pre-P2b server for backward-compat
   * proofs. Leaving this key out of the options object entirely (the normal
   * case) means "use the real computed fingerprint" — distinct from passing
   * `null`, which is why this is checked with `in`/`hasOwnProperty` at setup()
   * time rather than treated as equivalent to `undefined`.
   */
  bundleOverride?: string | null;
}

export function createWebAdapter(options: WebChannelOptions = {}): ChannelAdapter {
  const port = options.port ?? (Number(process.env.NANOCLAW_WEB_PORT) || DEFAULT_PORT);
  const host = options.host ?? DEFAULT_HOST;
  const dataDir = options.dataDir ?? path.join(process.cwd(), 'data');
  const staticRoot = options.staticDir ?? spaDir();
  const { token, generated } = resolveToken(dataDir);

  // Tailscale identity opt-in (see the file header). Read once, here, at
  // adapter creation: an env flip is a deploy-time decision, and re-reading it
  // per request would let the trust boundary move under a live connection.
  const trustTailscale = process.env.NANOCLAW_WEB_TRUST_TAILSCALE === '1';

  let server: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  const clients = new Set<WebSocket>();

  // Identity of each connected client, when there is one to know (i.e. it
  // authenticated via the trusted Tailscale header rather than the shared
  // token). Deliberately per-connection state and nothing more: this is the
  // foundation multi-user work will build on, NOT multi-user semantics —
  // routing, per-user history and per-user sessions all still treat this
  // adapter as the single-user surface it is today.
  const clientUserIds = new WeakMap<WebSocket, string>();

  /**
   * The verified tailnet login for this request, or null when there is none to
   * trust. Non-null ONLY under the explicit env opt-in — with the opt-in unset
   * this returns null before the header is even looked at, which is what keeps
   * the no-opt-in path byte-for-byte identical to the token-only behavior.
   */
  function trustedTailscaleLogin(req: http.IncomingMessage): string | null {
    if (!trustTailscale) return null;
    const raw = req.headers[TAILSCALE_LOGIN_HEADER];
    // Node hands back an array for a header sent more than once; take the
    // first, and treat an empty/whitespace-only value as absent (an empty
    // header must never authenticate anyone).
    const value = Array.isArray(raw) ? raw[0] : raw;
    if (typeof value !== 'string') return null;
    const login = value.trim();
    return login.length > 0 ? login : null;
  }

  /**
   * The ONE auth decision, shared by every authenticated entry point (the /ws
   * upgrade, /files/<id> download, /upload). Fixed AUTH precedence:
   *   1. a valid shared token   -> authenticated
   *   2. a trusted Tailscale-User-Login header -> authenticated
   *   3. neither                -> null; the caller rejects exactly as it did
   *                                before this feature (same status/close code)
   * IDENTITY is orthogonal to which credential authenticated: whenever the
   * trusted header is present (opt-in only, see trustedTailscaleLogin), its
   * login is reported as userId — including on token-authenticated requests.
   * A browser that kept a stored token from the pre-identity era would
   * otherwise authenticate fine but show no login, which reads as a bug from
   * the user's side. Attaching it costs nothing security-wise: under the
   * opt-in the header alone could have authenticated the same request anyway.
   * Token first and unchanged (constant-time compare, never logged), so
   * nothing about the header path can weaken it. Returning `{}` rather than a
   * bare boolean is what lets callers tell "authenticated, no identity" from
   * "authenticated as someone" without a second lookup.
   */
  function authenticate(req: http.IncomingMessage, url: URL): { userId?: string } | null {
    const login = trustedTailscaleLogin(req);
    if (tokenMatches(token, url.searchParams.get('token'))) return login ? { userId: login } : {};
    if (login) return { userId: login };
    return null;
  }

  // Files-IN (upload): the ChannelSetup handed to setup(), held so the
  // HTTP-only /upload handler (serveStatic, defined below, has no other
  // route to it) can call onInbound() the same way the WS message handler
  // does. Always set by the time a request can arrive — the HTTP server
  // itself is only created inside setup(), after this assignment.
  let currentConfig: ChannelSetup | null = null;

  // P2b: the SPA build fingerprint handed to clients in the `ready` frame.
  // Computed once per setup() (see the setup() body below) from whatever this
  // adapter instance is ACTUALLY serving, so a re-deploy (new process, fresh
  // dist/) is picked up automatically without a hand-bumped constant.
  let currentBundle: string | undefined;

  // Standard `ws` isAlive pattern: a WeakMap keyed on the socket (rather than
  // monkey-patching an `isAlive` property onto it) so a client that's already
  // gone gets garbage-collected instead of leaking an entry. Set true when a
  // client (re)connects and on every pong; the heartbeat interval below
  // flips it false before each ping and terminates any socket still false a
  // tick later — i.e. one that missed a pong entirely.
  const aliveClients = new WeakMap<WebSocket, boolean>();
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

  // Per-question render metadata, so a click can resolve its option index back
  // to the real value + selectedLabel (the native-adapter stand-in for the
  // host's getAskQuestionRender DB read).
  // `sessionId` rides along so a click resolves the card in the conversation
  // it was asked in — the client never has to name a session for an action,
  // and a card answered from a different tab still edits the right chat.
  const renderStore = new Map<
    string,
    { title: string; options: NormalizedOption[]; messageId: string; sessionId: string }
  >();

  // Every message/card id this adapter has handed back from deliver(), so an
  // operation:'edit' targeting an id we never produced can at least be logged
  // — the host is the source of truth for which id it stored, this is just a
  // sanity check on our side.
  const deliveredMessageIds = new Set<string>();

  // ---- Session registry (WU3) ----
  //
  // Every live conversation, keyed by session id (= threadId). Each one owns
  // the bounded in-memory replay ring and monotonic seq counter this adapter
  // used to keep globally — a reconnecting or switching client rebuilds ONE
  // conversation from the matching ring instead of showing a blank screen.
  // Mirrored to disk per session (see appendSessionFrame/readSessionFrames)
  // so a process restart — not just a teardown()+setup() bounce in the same
  // process — still has something to replay; the map itself is what survives
  // an in-process bounce (same closure), same as `history` did before.
  // Transient frames (typing, heartbeat) are never recorded — neither in a
  // ring nor on disk.
  const sessions = new Map<string, SessionState>();

  // The session each connection is LOOKING AT. Per-connection rather than
  // global because "is this frame visible to you right now, or does it just
  // dot your sidebar" is a property of the viewer, not of the server. With
  // today's single-user reality there is usually exactly one entry; the
  // WeakMap shape means a closed socket's entry disappears with the socket.
  const clientSessions = new WeakMap<WebSocket, string>();

  // The fallback session: what a brand-new connection starts on, where a
  // `deliver()` with a null threadId lands (legacy/system messages that never
  // went through a thread), and what an HTTP upload with no sessionId uses.
  // Persisted in index.json so a restart reopens the conversation the
  // operator was last in rather than an arbitrary one.
  let activeSessionId = '';

  // Bound on the in-memory ring, PER SESSION. Compaction kicks in once a
  // session's file grows past 4x that — otherwise an append-only log outlives
  // every eviction the ring already does and grows forever.
  const HISTORY_LIMIT = 200;
  const HISTORY_COMPACT_LIMIT = HISTORY_LIMIT * 4;

  // Bootstrapped exactly once per adapter INSTANCE, at the true cold-start
  // setup() — never on a teardown()+setup() bounce in the same process
  // (SIGUSR2 in the harness, a network re-init), because at that point the
  // session map already holds the live in-memory state and reloading from
  // disk would duplicate every frame already in a ring.
  let sessionsBootstrapped = false;

  function historyDir(): string {
    return path.join(dataDir, 'web-channel-history');
  }

  function sessionFilePath(id: string): string {
    return path.join(historyDir(), `${id}.jsonl`);
  }

  function indexFilePath(): string {
    return path.join(historyDir(), 'index.json');
  }

  /** Pre-WU3 layout: one file for the one conversation. Adopted once, on boot. */
  function legacyHistoryFilePath(): string {
    return path.join(dataDir, 'web-channel-history.jsonl');
  }

  function newSessionId(): string {
    return `ws-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`;
  }

  /**
   * Read one session's jsonl. Returns its tail (same HISTORY_LIMIT bound as
   * the live ring) plus the highest seq EVER written to it — not just the
   * highest in the retained tail, since a seq belonging to a
   * since-evicted/compacted-away frame must still never be reissued. That is
   * what keeps seq monotonic across a process restart: the client's replay
   * merge (useNanoclaw.ts) relies on seq being a strictly increasing,
   * never-repeating id within a conversation, and a naive `frameSeq = 0`
   * restart would immediately reissue seq 1 for a brand-new frame even though
   * a client may already hold an old seq 1. Corrupt/unparseable lines are
   * skipped with a warning; this must never throw — a bad history file is not
   * a reason to fail setup().
   */
  function readSessionFrames(id: string): { frames: Record<string, unknown>[]; maxSeq: number; lines: number } {
    let raw: string;
    try {
      raw = fs.readFileSync(sessionFilePath(id), 'utf8');
    } catch {
      return { frames: [], maxSeq: 0, lines: 0 }; // no file yet — nothing to load
    }
    const lines = raw.split('\n').filter((line) => line.trim().length > 0);
    const loaded: Record<string, unknown>[] = [];
    let maxSeq = 0;
    for (const line of lines) {
      let frame: unknown;
      try {
        frame = JSON.parse(line);
      } catch (err) {
        log.warn('Skipping corrupt web channel history line (invalid JSON)', { session: id, err });
        continue;
      }
      if (typeof frame !== 'object' || frame === null || typeof (frame as Record<string, unknown>).seq !== 'number') {
        log.warn('Skipping malformed web channel history line (missing numeric seq)', { session: id });
        continue;
      }
      const record = frame as Record<string, unknown>;
      loaded.push(record);
      if ((record.seq as number) > maxSeq) maxSeq = record.seq as number;
    }
    return { frames: loaded.slice(-HISTORY_LIMIT), maxSeq, lines: lines.length };
  }

  /** Rewrite one session's file to hold exactly its current (bounded) ring. */
  function compactSessionFile(session: SessionState): void {
    try {
      const body = session.history.map((frame) => JSON.stringify(frame)).join('\n');
      fs.writeFileSync(sessionFilePath(session.meta.id), session.history.length > 0 ? body + '\n' : '');
      session.linesOnDisk = session.history.length;
    } catch (err) {
      log.warn('Could not compact web channel session history (continuing uncompacted)', {
        session: session.meta.id,
        err,
      });
    }
  }

  /** Append one recorded frame to its session's file; synchronous so it survives a SIGTERM'd restart. */
  function appendSessionFrame(session: SessionState, frame: Record<string, unknown>): void {
    try {
      fs.mkdirSync(historyDir(), { recursive: true });
      fs.appendFileSync(sessionFilePath(session.meta.id), JSON.stringify(frame) + '\n');
      session.linesOnDisk++;
    } catch (err) {
      log.warn('Could not persist web channel history frame (continuing in-memory only)', {
        session: session.meta.id,
        err,
      });
      return;
    }
    if (session.linesOnDisk > HISTORY_COMPACT_LIMIT) compactSessionFile(session);
  }

  /** Sidebar-shaped view of the registry, most recently active first. */
  function sessionSummaries(): SessionMeta[] {
    return [...sessions.values()].map((s) => ({ ...s.meta })).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  /**
   * Rewrite index.json. Best-effort like every other persistence path here: a
   * failed write costs the titles/ordering of a restart, and the directory
   * scan below can rebuild both, so it is never a reason to fail an operation.
   */
  function writeIndex(): void {
    try {
      fs.mkdirSync(historyDir(), { recursive: true });
      fs.writeFileSync(
        indexFilePath(),
        JSON.stringify({ activeSession: activeSessionId, sessions: sessionSummaries() }, null, 2) + '\n',
      );
    } catch (err) {
      log.warn('Could not persist web channel session index (continuing in-memory only)', { err });
    }
  }

  /** Parse index.json, or null when it is missing, unreadable or not the shape we wrote. */
  function readIndex(): { activeSession: string | null; sessions: SessionMeta[] } | null {
    let raw: string;
    try {
      raw = fs.readFileSync(indexFilePath(), 'utf8');
    } catch {
      return null;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (typeof parsed !== 'object' || parsed === null) return null;
      const record = parsed as Record<string, unknown>;
      if (!Array.isArray(record.sessions)) return null;
      const metas: SessionMeta[] = [];
      for (const entry of record.sessions) {
        if (typeof entry !== 'object' || entry === null) continue;
        const e = entry as Record<string, unknown>;
        if (!isValidSessionId(e.id)) continue;
        metas.push({
          id: e.id,
          title: typeof e.title === 'string' ? e.title : '',
          createdAt: typeof e.createdAt === 'number' ? e.createdAt : Date.now(),
          lastActiveAt: typeof e.lastActiveAt === 'number' ? e.lastActiveAt : Date.now(),
        });
      }
      if (metas.length === 0) return null; // an index naming no usable session is no better than none
      return { activeSession: isValidSessionId(record.activeSession) ? record.activeSession : null, sessions: metas };
    } catch (err) {
      log.warn('Web channel session index is corrupt — rebuilding it from the history directory', { err });
      return null;
    }
  }

  /**
   * Rebuild the index by scanning the history directory. The jsonl files are
   * the source of truth — index.json is a convenience cache of titles and
   * ordering — so a corrupt/missing/truncated index costs metadata, never a
   * conversation. Titles fall back to the session's first user message, the
   * same rule that names a session live; timestamps fall back to the file's
   * own mtime when its frames carry no `ts` (pre-timestamp frames).
   */
  function rebuildIndexFromDisk(): SessionMeta[] {
    let entries: string[];
    try {
      entries = fs.readdirSync(historyDir());
    } catch {
      return [];
    }
    const metas: SessionMeta[] = [];
    for (const entry of entries) {
      if (!entry.endsWith('.jsonl')) continue; // skips index.json and archived `.jsonl.deleted` files
      const id = entry.slice(0, -'.jsonl'.length);
      if (!isValidSessionId(id)) {
        log.warn('Ignoring a history file whose name is not a valid session id', { file: entry });
        continue;
      }
      const { frames } = readSessionFrames(id);
      let title = '';
      for (const frame of frames) {
        if (frame.type === 'message' && frame.role === 'user' && typeof frame.content === 'string') {
          title = sessionTitleFrom(frame.content);
          break;
        }
      }
      let mtime = Date.now();
      try {
        mtime = fs.statSync(sessionFilePath(id)).mtimeMs;
      } catch {
        // best-effort — a file we just read should stat, but a missing stat is not fatal
      }
      const stamps = frames.map((f) => f.ts).filter((ts): ts is number => typeof ts === 'number');
      metas.push({
        id,
        title,
        createdAt: stamps.length > 0 ? Math.min(...stamps) : mtime,
        lastActiveAt: stamps.length > 0 ? Math.max(...stamps) : mtime,
      });
    }
    return metas;
  }

  /**
   * Adopt a pre-WU3 `web-channel-history.jsonl` as the session `default`,
   * exactly once: the rename is the idempotence: after it, the legacy path no
   * longer exists, so a second boot takes the early return. A legacy file
   * sitting next to an ALREADY adopted `default.jsonl` (someone restored an
   * old backup, a half-finished manual migration) is left strictly alone
   * rather than merged or clobbered — two histories cannot be interleaved
   * without renumbering seqs, and renumbering is exactly what the seq
   * guarantee forbids.
   */
  function adoptLegacyHistoryFile(): void {
    if (!fs.existsSync(legacyHistoryFilePath())) return;
    if (fs.existsSync(sessionFilePath(LEGACY_SESSION_ID))) {
      log.warn('Legacy web-channel-history.jsonl found next to an already-adopted default session — leaving it alone', {
        legacy: legacyHistoryFilePath(),
      });
      return;
    }
    try {
      fs.mkdirSync(historyDir(), { recursive: true });
      fs.renameSync(legacyHistoryFilePath(), sessionFilePath(LEGACY_SESSION_ID));
      log.info('Adopted the pre-sessions web channel history as session "default"', {
        file: sessionFilePath(LEGACY_SESSION_ID),
      });
    } catch (err) {
      log.warn('Could not adopt the legacy web-channel-history.jsonl (starting a fresh session instead)', { err });
    }
  }

  /** Register a session in memory, loading whatever its file already holds. */
  function loadSession(meta: SessionMeta): SessionState {
    const { frames, maxSeq, lines } = readSessionFrames(meta.id);
    const state: SessionState = { meta, history: frames, frameSeq: maxSeq, linesOnDisk: lines };
    sessions.set(meta.id, state);
    return state;
  }

  /** Create a brand-new, empty session and register it. Never persists frames — the file appears with the first one. */
  function createSession(id?: string): SessionState {
    const now = Date.now();
    const meta: SessionMeta = { id: id ?? newSessionId(), title: '', createdAt: now, lastActiveAt: now };
    const state: SessionState = { meta, history: [], frameSeq: 0, linesOnDisk: 0 };
    sessions.set(meta.id, state);
    return state;
  }

  /**
   * Cold-start only (see sessionsBootstrapped): adopt any legacy file, load
   * the index (or rebuild it from the directory), and guarantee that exactly
   * one session is active. There is ALWAYS at least one session after this
   * runs — a fresh install gets an empty one — so nothing downstream has to
   * handle "no conversation exists yet".
   */
  function bootstrapSessions(): void {
    try {
      fs.mkdirSync(historyDir(), { recursive: true });
    } catch (err) {
      log.warn('Could not create the web channel history directory (continuing in-memory only)', { err });
    }
    adoptLegacyHistoryFile();

    const index = readIndex();
    let metas = index?.sessions ?? [];
    let rebuilt = false;
    if (metas.length === 0) {
      metas = rebuildIndexFromDisk();
      rebuilt = metas.length > 0;
    } else {
      // The index names the sessions, but a file that exists on disk and is
      // missing from the index (a torn index write, a manually dropped file)
      // must still come back — the files are the source of truth.
      const known = new Set(metas.map((m) => m.id));
      for (const meta of rebuildIndexFromDisk()) {
        if (!known.has(meta.id)) {
          metas.push(meta);
          rebuilt = true;
        }
      }
    }

    for (const meta of metas) loadSession(meta);

    if (sessions.size === 0) {
      const fresh = createSession();
      activeSessionId = fresh.meta.id;
    } else {
      const preferred = index?.activeSession;
      activeSessionId =
        preferred && sessions.has(preferred) ? preferred : (sessionSummaries()[0]?.id ?? createSession().meta.id);
    }
    writeIndex();
    log.info('Loaded web channel sessions from disk', {
      sessions: sessions.size,
      active: activeSessionId,
      rebuiltIndex: rebuilt,
      frames: [...sessions.values()].reduce((n, s) => n + s.history.length, 0),
    });
  }

  /** The active session's state, creating one if the registry somehow emptied. */
  function activeSession(): SessionState {
    const current = sessions.get(activeSessionId);
    if (current) return current;
    const fresh = createSession();
    activeSessionId = fresh.meta.id;
    writeIndex();
    return fresh;
  }

  /**
   * The session for an id we did not create ourselves — a `deliver()`
   * threadId, mostly. An id we know is returned as-is; an unknown but
   * well-formed one is (re)created rather than folded into the active
   * conversation, because dropping a reply into the WRONG conversation is the
   * exact failure sessions exist to prevent (an id can be unknown because the
   * operator deleted the conversation while a turn was still in flight).
   */
  function ensureSession(id: string): SessionState {
    const existing = sessions.get(id);
    if (existing) return existing;
    log.warn('Delivery for an unknown web channel session — recreating it', { session: id });
    const created = createSession(id);
    writeIndex();
    broadcastSessions();
    return created;
  }

  function touchSession(session: SessionState, ts: number): void {
    session.meta.lastActiveAt = ts;
    writeIndex();
  }

  /**
   * Name a session after its first user message, openwebui-style. Only the
   * first one ever counts: a title that changed with every message would make
   * the sidebar unreadable, and renaming is deliberately out of WU3.
   */
  function maybeSetTitle(session: SessionState, text: string): void {
    if (session.meta.title) return;
    const title = sessionTitleFrom(text);
    if (!title) return;
    session.meta.title = title;
    writeIndex();
    broadcastSessions();
  }

  /** Archive a session's frames instead of erasing them (delete = archive, per the WU3 design). */
  function archiveSessionFile(id: string): void {
    const from = sessionFilePath(id);
    if (!fs.existsSync(from)) return;
    let to = `${from}.deleted`;
    if (fs.existsSync(to)) to = `${from}.${Date.now()}.deleted`; // never clobber an earlier archive
    try {
      fs.renameSync(from, to);
      log.info('Archived a deleted web channel session', { session: id, archive: to });
    } catch (err) {
      log.warn('Could not archive the deleted session history (leaving it in place)', { session: id, err });
    }
  }

  /** The session a connection is currently viewing (its own, else the global active one). */
  function viewOf(ws: WebSocket): string {
    const view = clientSessions.get(ws);
    if (view && sessions.has(view)) return view;
    return activeSession().meta.id;
  }

  /**
   * Point a connection at a session and make it the fallback for everything
   * that has no connection of its own (an upload, a null-threadId deliver).
   * Single-user demo semantics: the last switch anywhere wins.
   */
  function setView(ws: WebSocket, id: string): void {
    clientSessions.set(ws, id);
    activeSessionId = id;
    writeIndex();
  }

  /** Broadcast the session list to every client. Not a recorded frame: pure UI state, no seq, never replayed. */
  function broadcastSessions(): void {
    broadcast({ type: 'sessions', sessions: sessionSummaries() });
  }

  /** Replay one session's ring to one client. Carries `sessionId` so the client knows which conversation it just received. */
  function sendHistory(ws: WebSocket, session: SessionState): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify({ type: 'history', sessionId: session.meta.id, frames: session.history }));
    } catch (err) {
      log.warn('Failed to send a history replay to a client', { err });
    }
  }

  // P2a outbound attachments: id -> bytes. `files` is a Map so insertion
  // order IS FIFO eviction order (see evictOldestFilesIfNeeded). Cleared on
  // teardown (unlike `history`, which deliberately survives a
  // teardown()+setup() bounce) — a torn-down file map has nobody left to
  // serve /files/<id> until setup() runs again anyway, so the ids get marked
  // evicted (410, not 404) rather than silently becoming 404s.
  const files = new Map<string, RegisteredFile>();
  const evictedFileIds = new Set<string>();
  let filesTotalBytes = 0;

  function evictOldestFilesIfNeeded(): void {
    while (files.size > FILE_COUNT_LIMIT || filesTotalBytes > FILE_BYTES_LIMIT) {
      const oldestId: string | undefined = files.keys().next().value;
      if (oldestId === undefined) break;
      const oldest = files.get(oldestId);
      files.delete(oldestId);
      if (oldest) filesTotalBytes -= oldest.size;
      evictedFileIds.add(oldestId);
    }
  }

  /**
   * Register one outbound file for HTTP download. Returns null (never
   * throws) for anything unservable — no filename, no data, or a
   * zero-length buffer — so deliver() can fall back to a plain "could not
   * be relayed" message instead of silently dropping it.
   */
  // `mimeOverride`: the upload path (files-IN) already knows a real
  // browser-reported (and allow-list-sanitized, see sanitizeUploadMime)
  // Content-Type, which is more accurate than guessing from the extension —
  // outbound files (OutboundFile carries no mime at all) omit it and keep
  // the existing mimeForFilename(extension) behavior unchanged.
  function registerFile(file: OutboundFile | null | undefined, mimeOverride?: string): RegisteredFile | null {
    if (
      !file ||
      typeof file.filename !== 'string' ||
      !file.filename ||
      !Buffer.isBuffer(file.data) ||
      file.data.length === 0
    ) {
      return null;
    }
    const id = crypto.randomBytes(16).toString('base64url');
    const registered: RegisteredFile = {
      id,
      filename: path.basename(file.filename),
      mime: mimeOverride && mimeOverride.trim() ? mimeOverride.trim() : mimeForFilename(file.filename),
      size: file.data.length,
      data: file.data,
    };
    files.set(id, registered);
    filesTotalBytes += registered.size;
    evictOldestFilesIfNeeded();
    return registered;
  }

  let seq = 0;
  const nextId = (prefix: string) => `${prefix}-${Date.now()}-${(seq++).toString(36)}`;

  // Current typing state, tracked here (not just fired-and-forgotten through
  // broadcast()) so a (re)connecting client can be told the truth on its
  // 'ready' frame instead of starting from a blind guess. Typing frames stay
  // transient — excluded from `history` by design (see HISTORY_LIMIT comment
  // above) — this is a SEPARATE single-boolean piece of state, not a frame
  // log, so it costs nothing to keep it live across a teardown()+setup()
  // bounce (same adapter-instance closure) or a client that was never
  // subscribed when the last change broadcast.
  let typingState = false;

  function setTypingState(on: boolean): void {
    typingState = on;
    broadcast({ type: 'typing', on });
  }

  // Monotonic sequence stamped on every RECORDED frame (see emit() below),
  // counted PER SESSION (SessionState.frameSeq) — separate from the id
  // counter above, which also numbers frames that never go through emit()
  // (e.g. card_resolved shares nextId's messageId space indirectly via
  // renderStore, not directly). The client uses seq to merge a replayed
  // history snapshot with whatever it already applied live instead of
  // blindly overwriting: reconnect (subscribe, i.e. clients.add()) happens
  // before the snapshot is read below, so no frame recorded from this point
  // on can be missed by broadcast — but the reverse isn't free: nothing
  // stops a client from applying a live frame and THEN receiving a history
  // snapshot that predates it (a slower snapshot build, a future change that
  // adds an await here, a retried/duplicated send). seq is the client's
  // defense against that: idempotent, order-tolerant replay. Per-session
  // rather than global because the client only ever holds ONE conversation's
  // frames at a time, and a per-session counter keeps each conversation's
  // numbering independent of how busy its neighbors were.

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

  /**
   * Send one recorded frame to whoever should see it: clients VIEWING that
   * session get the frame itself, everyone else gets a lightweight
   * `session_activity` marker so their sidebar can dot the conversation
   * without pulling frames for a chat nobody is reading. "Viewing" is
   * per-connection (viewOf) — the honest definition for today's single-user
   * reality, and the one multi-user work will keep.
   */
  function routeFrame(session: SessionState, frame: Record<string, unknown>): void {
    const data = JSON.stringify(frame);
    const activity = JSON.stringify({
      type: 'session_activity',
      sessionId: session.meta.id,
      lastActiveAt: session.meta.lastActiveAt,
    });
    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      try {
        ws.send(viewOf(ws) === session.meta.id ? data : activity);
      } catch (err) {
        log.warn('Failed to send frame to a client', { err });
      }
    }
  }

  /**
   * Record a frame into one session's replay history AND route it — in that
   * order, unconditionally, regardless of whether any client is currently
   * connected. This is what makes deliver() safe to call with zero clients:
   * the answer still lands in the session's ring for whoever reconnects
   * later, even though routeFrame() has nobody to send it to right now. Every
   * recorded frame gets a monotonically increasing per-session `seq` first,
   * so a client that replays that session's history can tell exactly which
   * live frames it already has, plus the `sessionId` it belongs to so a
   * client can never fold a frame into the wrong conversation.
   *
   * Also stamps a wall-clock `ts` (epoch ms) alongside `seq` — the message-
   * timestamp feature. Stamped once, here, at the moment the frame is first
   * recorded: a replayed history frame is the SAME object pushed below, so
   * replay never re-stamps it — a reconnecting client sees the original send
   * time, not the reconnect time. The two counters answer different
   * questions (seq: "what order, and have I already applied this exact
   * frame" / ts: "when, in wall-clock terms, for display") and deliberately
   * don't derive one from the other.
   */
  function emit(sessionId: string, frame: Record<string, unknown>): void {
    const session = ensureSession(sessionId);
    frame.seq = ++session.frameSeq;
    frame.ts = Date.now();
    frame.sessionId = session.meta.id;
    session.history.push(frame);
    if (session.history.length > HISTORY_LIMIT) session.history.shift();
    // Persist before broadcasting: a crash between the two would rather lose
    // a live delivery than lose durability of one that already went out.
    appendSessionFrame(session, frame);
    touchSession(session, frame.ts as number);
    routeFrame(session, frame);
  }

  /**
   * Files-IN. Parses a multipart/form-data POST (`file` parts, plus an
   * optional plain `text` field), registers each file the same way an
   * outbound attachment is registered (same map, same eviction caps — "mind
   * the eviction caps" per the design brief), renders each as a `file` frame
   * with `role: 'user'`, and hands the whole turn to the host with an
   * attachment shape that mirrors the Chat SDK bridge's
   * (chat-sdk-bridge.ts messageToInbound, `serialized.attachments`)
   * byte-for-byte: `{ type, name, mimeType, size, data(base64) }` per file —
   * so the host's extractAttachmentFiles/attachment-naming/attachment-safety
   * pipeline (session-manager.ts) treats a web upload exactly like a
   * downloaded chat-sdk attachment, no new host-side shape to support.
   */
  async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse, url: URL): Promise<void> {
    try {
      const contentLengthHeader = req.headers['content-length'];
      if (contentLengthHeader && Number(contentLengthHeader) > MAX_UPLOAD_BODY_BYTES) {
        throw new UploadError(413, 'upload too large');
      }
      const boundary = parseMultipartBoundary(req.headers['content-type']);
      const body = await readBodyCapped(req, MAX_UPLOAD_BODY_BYTES);
      const parts = parseMultipart(body, boundary);

      const textPart = parts.find((p) => p.name === 'text' && !p.filename);
      const fileParts = parts.filter((p) => p.filename);

      if (fileParts.length === 0) throw new UploadError(400, 'no files in upload');
      if (fileParts.length > MAX_FILES_PER_MESSAGE) {
        throw new UploadError(400, `too many files (max ${MAX_FILES_PER_MESSAGE} per message)`);
      }
      for (const part of fileParts) {
        if (part.data.length === 0) throw new UploadError(400, `"${part.filename}" is empty`);
        if (part.data.length > MAX_FILE_BYTES) {
          throw new UploadError(413, `"${part.filename}" exceeds the 25MB limit`);
        }
      }

      if (!currentConfig) throw new UploadError(503, 'channel not ready');

      const text = textPart ? textPart.data.toString('utf8').trim() : '';

      // Which conversation this upload belongs to. The SPA appends
      // `?sessionId=` (same query-string convention as `?token=`); an
      // upload without one — an older client, a curl probe — lands in the
      // active session, the same fallback a WS `user_message` without a
      // sessionId gets. An unknown-but-well-formed id is (re)created rather
      // than silently redirected, mirroring ensureSession()'s stance.
      const requestedSession = url.searchParams.get('sessionId');
      const session = isValidSessionId(requestedSession) ? ensureSession(requestedSession) : activeSession();
      const sessionId = session.meta.id;
      if (text) maybeSetTitle(session, text);

      // The user's own text, rendered as a normal user message bubble — same
      // frame shape and history treatment as a plain WS user_message (see
      // handleClientFrame below), just triggered from the HTTP upload path
      // instead of the WS socket. Files are emitted below, AFTER this, so a
      // caption reads above its attachment (comment mirrors the WS path's
      // "record the operator's own message" note).
      if (text) {
        emit(sessionId, { type: 'message', id: nextId('user'), role: 'user', content: text });
      }

      const registeredFiles: RegisteredFile[] = [];
      for (const part of fileParts) {
        const mime = sanitizeUploadMime(part.contentType, part.filename);
        const registered = registerFile({ filename: part.filename, data: part.data }, mime);
        if (!registered) continue; // the size/emptiness checks above already rule this out in practice
        registeredFiles.push(registered);
        // role: 'user' — reuses the exact same 'file' frame type an outbound
        // (assistant) attachment uses (see deliver() below), just aligned to
        // the other side by AttachmentRow.tsx. This is why files-IN needed no
        // new frame type, and so no new case in the SPA's onmessage switch /
        // reducer / SeqFrame exclusion list — only a field on the existing one.
        emit(sessionId, {
          type: 'file',
          id: registered.id,
          name: registered.filename,
          mime: registered.mime,
          size: registered.size,
          downloadPath: `/files/${registered.id}`,
          role: 'user',
        });
      }

      // A real user turn just started — clear any stale typing indicator,
      // same as the plain-text WS path (setTypingState(false) further down
      // in deliver()).
      setTypingState(false);

      // Mirror the Chat SDK bridge's attachment enrichment byte-for-byte
      // (chat-sdk-bridge.ts messageToInbound, ~L160-190): each entry carries
      // type/name/mimeType/size/data — width/height are the bridge's for
      // image/video attachments with known dimensions, which a browser file
      // upload has no equivalent of, so they're omitted here exactly as the
      // bridge itself omits them for attachments it can't measure.
      const attachments = registeredFiles.map((f) => ({
        type: f.mime.startsWith('image/') ? 'image' : 'file',
        name: f.filename,
        mimeType: f.mime,
        size: f.size,
        data: f.data.toString('base64'),
      }));

      const content: Record<string, unknown> = {
        sender: 'web',
        senderId: `${CHANNEL_TYPE}:${PLATFORM_ID}`,
        attachments,
      };
      if (text) content.text = text;

      void Promise.resolve(
        // threadId = the session id: this is what buys a distinct host agent
        // session per UI conversation (see the file header).
        currentConfig.onInbound(PLATFORM_ID, sessionId, {
          id: nextId('web'),
          kind: 'chat',
          timestamp: new Date().toISOString(),
          content,
          isMention: true,
          isGroup: false,
        }),
      ).catch((err) => log.error('onInbound threw (upload)', { err }));

      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          ok: true,
          files: registeredFiles.map((f) => ({
            id: f.id,
            name: f.filename,
            size: f.size,
            downloadPath: `/files/${f.id}`,
          })),
        }),
      );
    } catch (err) {
      const status = err instanceof UploadError ? err.status : 400;
      const message = err instanceof Error ? err.message : 'upload failed';
      if (!(err instanceof UploadError)) log.warn('Upload failed unexpectedly', { err });
      try {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: message }));
      } catch {
        // response may already be half-written/closed (e.g. socket
        // destroyed by readBodyCapped on an oversized body) — nothing more
        // to do.
      }
    }
  }

  function serveStatic(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = new URL(req.url ?? '/', `http://${host}`);
    let pathname = decodeURIComponent(url.pathname);

    if (pathname === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, channel: CHANNEL_TYPE }));
      return;
    }

    // P2a attachment download — same auth decision as the WS upgrade (token
    // query param first, then the trusted Tailscale header under the opt-in;
    // see authenticate()), gated BEFORE existence is even checked so an
    // unauthenticated caller can't use this to probe which ids exist.
    if (pathname.startsWith('/files/')) {
      if (!authenticate(req, url)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      const id = pathname.slice('/files/'.length);
      const file = files.get(id);
      if (!file) {
        const gone = evictedFileIds.has(id);
        res.writeHead(gone ? 410 : 404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: gone ? 'gone' : 'not found' }));
        return;
      }
      const wantsInline = url.searchParams.get('inline') === '1';
      const disposition = wantsInline && mimeSafeForInlineDisposition(file.mime) ? 'inline' : 'attachment';
      res.writeHead(200, {
        'content-type': file.mime,
        'content-length': String(file.size),
        'content-disposition': contentDispositionHeader(file.filename, disposition),
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
      });
      // HEAD gets headers only (lets the SPA probe availability — see
      // AttachmentRow.tsx's "no longer available" check — without pulling
      // the whole body over the wire).
      res.end(req.method === 'HEAD' ? undefined : file.data);
      return;
    }

    // Files-IN — multipart upload. Auth checked BEFORE anything else (same
    // authenticate() gate, same query-param convention as /files/ above),
    // before even the method/body is looked at, so an unauthenticated caller
    // can't use this to probe endpoint behavior.
    if (pathname === '/upload') {
      if (!authenticate(req, url)) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      void handleUpload(req, res, url);
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
            res.writeHead(200, {
              'content-type': CONTENT_TYPES['.html'],
              'cache-control': 'no-store',
            });
            res.end(idx);
          });
          return;
        }
        res.writeHead(404);
        res.end('not found');
        return;
      }
      const ext = path.extname(resolved);
      const type = CONTENT_TYPES[ext] ?? 'application/octet-stream';
      // index.html must never be cached (it names the hashed bundles); the
      // hashed .js/.css bundles themselves are immutable by construction.
      const cache =
        ext === '.html'
          ? 'no-store'
          : ext === '.js' || ext === '.css'
            ? 'public, max-age=31536000, immutable'
            : 'no-cache';
      res.writeHead(200, { 'content-type': type, 'cache-control': cache });
      res.end(buf);
    });
  }

  function handleClientFrame(raw: string, config: ChannelSetup, ws: WebSocket): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      log.warn('Ignoring non-JSON frame from client');
      return;
    }

    // ---- Session ops (WU3) ----
    //
    // Switching is server-authoritative: the client asks, the server answers
    // with that session's history replay (which carries its `sessionId`), and
    // the client adopts the conversation the replay names. That keeps a
    // client from ever showing a conversation the server did not hand it.
    if (msg.type === 'create_session') {
      const session = createSession();
      setView(ws, session.meta.id);
      broadcastSessions();
      sendHistory(ws, session); // empty, but it is what tells this client which session it is now on
      log.info('Web client created a session', { session: session.meta.id, sessions: sessions.size });
      return;
    }

    if (msg.type === 'switch_session') {
      if (!isValidSessionId(msg.id) || !sessions.has(msg.id)) {
        // Unknown/malformed id: resync the client's list rather than
        // silently doing nothing, so a stale sidebar corrects itself.
        log.warn('Ignoring switch_session for an unknown session', { requested: msg.id });
        broadcastSessions();
        return;
      }
      setView(ws, msg.id);
      sendHistory(ws, sessions.get(msg.id)!);
      return;
    }

    if (msg.type === 'delete_session') {
      if (!isValidSessionId(msg.id) || !sessions.has(msg.id)) {
        broadcastSessions();
        return;
      }
      const removed = msg.id;
      sessions.delete(removed);
      archiveSessionFile(removed);
      // There is ALWAYS an active session: deleting the last one immediately
      // opens a fresh empty conversation rather than leaving the UI with
      // nothing to show and nowhere for a reply to land.
      if (sessions.size === 0) createSession();
      if (activeSessionId === removed) activeSessionId = sessionSummaries()[0].id;
      writeIndex();
      broadcastSessions();
      // Anyone who was looking at the deleted conversation gets moved onto a
      // real one, with its replay, instead of staring at a dead list entry.
      for (const client of clients) {
        if (clientSessions.get(client) === removed) {
          clientSessions.set(client, activeSessionId);
          sendHistory(client, activeSession());
        }
      }
      log.info('Web client deleted a session', { session: removed, sessions: sessions.size });
      return;
    }

    if (msg.type === 'user_message' && typeof msg.text === 'string' && msg.text.length > 0) {
      // Record the operator's own message into the same replay history the
      // assistant side already uses (emit() below), so a refresh doesn't drop
      // the user's half of the conversation — the gap this fixes. Reuse the
      // client's own locally-generated id when it sends one (see
      // useNanoclaw.ts sendMessage) so the browser's optimistic local echo
      // and this recorded frame carry the SAME id: the client reducer then
      // replaces the echo in place instead of showing the message twice.
      // Falls back to a server-generated id for older/other clients that
      // don't send one — never breaks the wire contract.
      const clientId = typeof msg.clientId === 'string' && msg.clientId.length > 0 ? msg.clientId : undefined;
      // `sessionId` is optional on the wire: absent means "the session this
      // connection is viewing", which is what keeps every pre-WU3 probe
      // script (and any client that never learned about sessions) working
      // unchanged against a sessions-aware server.
      const session =
        isValidSessionId(msg.sessionId) && sessions.has(msg.sessionId)
          ? sessions.get(msg.sessionId)!
          : sessions.get(viewOf(ws))!;
      const sessionId = session.meta.id;
      maybeSetTitle(session, msg.text);
      emit(sessionId, { type: 'message', id: clientId ?? nextId('user'), role: 'user', content: msg.text });

      void Promise.resolve(
        // threadId = the session id. The host keys its agent sessions on
        // (messaging_group_id, thread_id), so this is the whole mechanism by
        // which one sidebar conversation becomes one agent session.
        config.onInbound(PLATFORM_ID, sessionId, {
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
      // then dispatch onAction — mirroring the bridge's order. The resolution
      // lands in the card's OWN session (renderStore), not the clicking
      // connection's current view: the two differ the moment someone switches
      // conversations with a card still open. `onAction` itself carries no
      // thread parameter in the ChannelSetup contract (adapter.ts), so the
      // host resolves the question by questionId — nothing to thread through.
      const cardSession = render?.sessionId ?? viewOf(ws);
      emit(cardSession, { type: 'card_resolved', questionId, selectedIndex, selectedLabel, actor: 'you' });
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
    // WU3: one sidebar conversation is one thread. The router pre-strips
    // thread ids from adapters that declare this false (src/router.ts), which
    // would collapse every conversation back onto one agent session, so this
    // flag is load-bearing — not cosmetic.
    supportsThreads: true,
    defaults: WEB_DEFAULTS,

    async setup(config: ChannelSetup): Promise<void> {
      currentConfig = config;

      // Cold-start only (see bootstrapSessions' doc comment): restores every
      // session's ring + seq counter from the jsonl mirrors so a process
      // restart (not just a teardown()+setup() bounce) still has
      // conversations to replay, and so newly emitted frames keep counting up
      // from where the previous process left off instead of colliding with
      // old seqs.
      if (!sessionsBootstrapped) {
        sessionsBootstrapped = true;
        bootstrapSessions();
      }

      // P2b: resolve the bundle fingerprint once per setup(), from whatever
      // is ACTUALLY on disk under staticRoot right now — never a stale value
      // held over from a previous setup() in this same process (a
      // teardown()+setup() bounce, e.g. SIGUSR2 in the test harness, must see
      // a fresh dist/ if one was swapped in between). `bundleOverride` is
      // test/harness-only (see WebChannelOptions doc) and, when present at
      // all (even as `null`), wins over the real computation.
      currentBundle = Object.prototype.hasOwnProperty.call(options, 'bundleOverride')
        ? (options.bundleOverride ?? undefined)
        : readBundleFingerprint(staticRoot);

      server = http.createServer((req, res) => serveStatic(req, res));
      wss = new WebSocketServer({ noServer: true });

      server.on('upgrade', (req, socket, head) => {
        const url = new URL(req.url ?? '/', `http://${host}`);
        if (url.pathname !== '/ws') {
          socket.destroy();
          return;
        }
        // Same shared decision as the HTTP endpoints (see authenticate()):
        // valid token, else a trusted Tailscale login under the opt-in, else
        // the unchanged 4401 rejection below.
        const auth = authenticate(req, url);
        if (!auth) {
          // Complete the WS handshake rather than rejecting the HTTP upgrade
          // with a raw 401: the browser's WebSocket API cannot see an HTTP
          // status code on a failed upgrade, only an opaque close code 1006
          // (no reason, indistinguishable from a network blip) — which is
          // why the SPA used to retry forever with backoff instead of
          // showing the login/token screen. Accepting, then immediately
          // closing with app-level code 4401 gives the client something it
          // CAN act on: useNanoclaw.ts's onclose special-cases 4401 to clear
          // the stored token and show the login screen instead of
          // reconnecting. Never added to `clients`, so it never touches
          // history/broadcast.
          wss!.handleUpgrade(req, socket, head, (ws) => {
            log.info('Web client rejected: no valid token or trusted identity');
            ws.close(4401, 'invalid token');
          });
          return;
        }
        wss!.handleUpgrade(req, socket, head, (ws) => {
          // Subscribe BEFORE reading the snapshot: this client is a
          // broadcast target from this line on, so any deliver() that lands
          // from this point forward reaches it live (no gap where a frame
          // could be neither in the snapshot below nor delivered live). The
          // ordering only holds because nothing between here and the two
          // ws.send() calls below awaits — if that ever changes, the seq
          // numbers stamped in emit() are the fallback the client reducer
          // relies on to merge instead of silently losing the overlap.
          clients.add(ws);
          aliveClients.set(ws, true);
          if (auth.userId) clientUserIds.set(ws, auth.userId);
          ws.on('pong', () => aliveClients.set(ws, true));
          // `userId` is omitted from the log line entirely when the client
          // authenticated by token — absent means "not known", never "".
          log.info(
            'Web client connected',
            auth.userId ? { clients: clients.size, userId: auth.userId } : { clients: clients.size },
          );
          // Replay everything we remember about the ACTIVE conversation
          // BEFORE 'ready', so the SPA rebuilds it before it flips to the
          // connected state — this is what makes a reconnect (dropped socket,
          // or the whole ws layer bouncing) look seamless instead of blank.
          // Only the active session's frames: the sidebar needs metadata, not
          // every conversation's backlog, and a switch fetches the rest.
          const opened = activeSession();
          clientSessions.set(ws, opened.meta.id);
          sendHistory(ws, opened);
          // Carry the CURRENT typing state so a (re)connecting client starts
          // truthful instead of stuck on whatever `typing` value it had
          // before the drop — typing frames are transient and never land in
          // `history`, so without this a client that missed the one
          // clearing frame (dropped mid-turn, reconnected after the server
          // already went quiet) would show ghost dots forever.
          // P2b: `bundle` is omitted entirely (not sent as null/empty) when
          // there's nothing to report — the SPA's backward-compat contract is
          // "field absent => do nothing", never "field present but falsy".
          // `userId` follows the same absent-means-nothing-to-report contract
          // as `bundle`: sent only when this connection actually has a
          // verified identity (Tailscale header path), omitted entirely for a
          // token-authenticated client, so the SPA can treat "field present"
          // as "there is a login to show" with no falsy special cases.
          // WU3: `sessions` + `activeSession` are the sidebar's initial state,
          // and `threadId` — historically always null — now names the thread
          // this connection is actually on, which is the session it opened.
          const readyFrame: Record<string, unknown> = {
            type: 'ready',
            threadId: opened.meta.id,
            typing: typingState,
            sessions: sessionSummaries(),
            activeSession: opened.meta.id,
          };
          if (currentBundle) readyFrame.bundle = currentBundle;
          if (auth.userId) readyFrame.userId = auth.userId;
          ws.send(JSON.stringify(readyFrame));
          ws.on('message', (data) => handleClientFrame(data.toString('utf8'), config, ws));
          ws.on('close', () => {
            const userId = clientUserIds.get(ws);
            clients.delete(ws);
            clientUserIds.delete(ws);
            clientSessions.delete(ws);
            log.info('Web client disconnected', userId ? { clients: clients.size, userId } : { clients: clients.size });
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

      // One interval drives both halves of half-open-socket detection (see
      // the HEARTBEAT_INTERVAL_MS comment above). Order matters: ping/check
      // first so a socket terminated this tick doesn't also receive the
      // heartbeat broadcast below.
      heartbeatTimer = setInterval(() => {
        for (const ws of clients) {
          if (aliveClients.get(ws) === false) {
            log.warn('Terminating unresponsive web client (missed heartbeat pong)');
            clients.delete(ws);
            ws.terminate();
            continue;
          }
          aliveClients.set(ws, false);
          ws.ping();
        }
        // App-level heartbeat, broadcast-only (never emit()): the client
        // deadman timer resets on ANY incoming frame, but this frame must
        // never enter the seq'd replay history — it carries no `seq` and
        // deliberately bypasses emit() so it can't disturb frameSeq or get
        // replayed to a reconnecting client (see emit()'s docs above).
        broadcast({ type: 'heartbeat' });
      }, HEARTBEAT_INTERVAL_MS);
    },

    async teardown(): Promise<void> {
      // Files still registered at teardown become explicitly gone (410) once
      // torn down, rather than lingering as ids nobody can serve until the
      // next setup() — mirrors eviction rather than inventing a third state.
      for (const id of files.keys()) evictedFileIds.add(id);
      files.clear();
      filesTotalBytes = 0;
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
      }
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

    async deliver(platformId, threadId, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== PLATFORM_ID) return undefined;
      const content = (message.content ?? {}) as Record<string, unknown>;

      // WU3 routing: the threadId this delivery came back on IS the UI
      // conversation it belongs to (the same id onInbound handed the host).
      // Three cases, all deliberate:
      //  - a known session      -> the frame lands in that conversation
      //  - an unknown, well-formed id -> ensureSession recreates it rather
      //    than dropping the reply into whatever chat happens to be open
      //  - null (a legacy/system delivery that never rode a thread, or a
      //    wiring whose thread policy stripped the id) -> the active session,
      //    recorded there like any other frame. This is the ONE case where a
      //    reply can land in a conversation other than the one that asked,
      //    and it only happens when the host tells us nothing about which.
      const sid = (() => {
        if (threadId === null || threadId === undefined) return activeSession().meta.id;
        if (!isValidSessionId(threadId)) {
          log.warn('Delivery for a malformed threadId — falling back to the active session', { threadId });
          return activeSession().meta.id;
        }
        return ensureSession(threadId).meta.id;
      })();

      // P2a outbound attachments. `files` is orthogonal to `content` (an
      // edit/card/message can in principle carry files too), so this runs
      // unconditionally before the content-shape branching below rather than
      // being folded into the plain-message branch at the bottom. Real
      // incident this fixes: the model sent code as a file, deliver() DROPPED
      // it silently, the user saw nothing and the agent claimed success.
      // Never-drop: a file we can't register still becomes a visible message
      // (mirrors the send_card fallbackText path further down).
      let lastFileMessageId: string | undefined;
      if (message.files && message.files.length > 0) {
        for (const file of message.files) {
          const registered = registerFile(file);
          if (registered) {
            setTypingState(false); // a delivered file is a real deliverable, same as a real message
            deliveredMessageIds.add(registered.id);
            emit(sid, {
              type: 'file',
              id: registered.id,
              name: registered.filename,
              mime: registered.mime,
              size: registered.size,
              downloadPath: `/files/${registered.id}`,
              role: 'assistant',
            });
            lastFileMessageId = registered.id;
          } else {
            const label = file?.filename || '(unnamed file)';
            const messageId = nextId('msg');
            deliveredMessageIds.add(messageId);
            emit(sid, {
              type: 'message',
              id: messageId,
              role: 'assistant',
              content: `[the agent tried to send a file (${label}) but it could not be relayed]`,
            });
            lastFileMessageId = messageId;
          }
        }
      }

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
        emit(sid, { type: 'edit', id: messageId, content: text });
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
        renderStore.set(questionId, { title, options, messageId, sessionId: sid });
        emit(sid, {
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
            emit(sid, { type: 'message', id: messageId, role: 'assistant', content: fallbackText });
            return messageId;
          }
          log.warn('send_card payload empty, skipping delivery');
          return undefined;
        }

        const messageId = nextId('gcard');
        deliveredMessageIds.add(messageId);
        emit(sid, { type: 'generic_card', id: messageId, title, body, links, fallbackText });
        return messageId;
      }

      // Typing off — a real message supersedes any streaming indicator.
      setTypingState(false);

      // Normal message — prefer markdown, fall back to text (mirrors the
      // bridge's rawText = content.markdown || content.text).
      const text = (content.markdown as string) || (content.text as string);
      if (text) {
        const messageId = nextId('msg');
        deliveredMessageIds.add(messageId);
        emit(sid, { type: 'message', id: messageId, role: 'assistant', content: text });
        return messageId;
      }
      // No text/card/edit content — if this delivery was files-only, hand
      // back the last file's id (there's no case where callers pass BOTH a
      // meaningful content shape AND expect the file id back; text/card/edit
      // ids above already took priority via their own early returns).
      return lastFileMessageId;
    },

    async setTyping(platformId): Promise<void> {
      if (platformId !== PLATFORM_ID) return;
      setTypingState(true);
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
