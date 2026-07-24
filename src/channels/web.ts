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
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundFile, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const CHANNEL_TYPE = 'web';
const PLATFORM_ID = 'local';
const DEFAULT_PORT = 7890;
const DEFAULT_HOST = '127.0.0.1';

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
function contentDispositionHeader(filename: string): string {
  const quoted = filename.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const encoded = encodeURIComponent(filename).replace(/['()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
  return `attachment; filename="${quoted}"; filename*=UTF-8''${encoded}`;
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

  let server: http.Server | null = null;
  let wss: WebSocketServer | null = null;
  const clients = new Set<WebSocket>();

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

  // Monotonic sequence stamped on every RECORDED frame (see emit() below) —
  // separate from the id counter above, which also numbers frames that never
  // go through emit() (e.g. card_resolved shares nextId's messageId space
  // indirectly via renderStore, not directly). The client uses this to merge
  // a replayed history snapshot with whatever it already applied live
  // instead of blindly overwriting: reconnect (subscribe, i.e. clients.add())
  // happens before the snapshot is read below, so no frame recorded from
  // this point on can be missed by broadcast — but the reverse isn't free:
  // nothing stops a client from applying a live frame and THEN receiving a
  // history snapshot that predates it (a slower snapshot build, a future
  // change that adds an await here, a retried/duplicated send). seq is the
  // client's defense against that: idempotent, order-tolerant replay.
  let frameSeq = 0;

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
   * Record a frame into the replay history AND broadcast it — in that order,
   * unconditionally, regardless of whether any client is currently connected.
   * This is what makes deliver() safe to call with zero clients: the answer
   * still lands in `history` for whoever reconnects later, even though
   * broadcast() has nobody to send it to right now. Every recorded frame
   * gets a monotonically increasing `seq` first, so a client that replays
   * `history` can tell exactly which live frames it already has.
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
  function emit(frame: Record<string, unknown>): void {
    frame.seq = ++frameSeq;
    frame.ts = Date.now();
    history.push(frame);
    if (history.length > HISTORY_LIMIT) history.shift();
    broadcast(frame);
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
  async function handleUpload(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
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

      // The user's own text, rendered as a normal user message bubble — same
      // frame shape and history treatment as a plain WS user_message (see
      // handleClientFrame below), just triggered from the HTTP upload path
      // instead of the WS socket. Files are emitted below, AFTER this, so a
      // caption reads above its attachment (comment mirrors the WS path's
      // "record the operator's own message" note).
      if (text) {
        emit({ type: 'message', id: nextId('user'), role: 'user', content: text });
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
        emit({
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
        currentConfig.onInbound(PLATFORM_ID, null, {
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

    // P2a attachment download — same token auth as the WS upgrade (query
    // param, constant-time compare), gated BEFORE existence is even checked
    // so a bad token can't be used to probe which ids exist.
    if (pathname.startsWith('/files/')) {
      if (!tokenMatches(token, url.searchParams.get('token'))) {
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
      res.writeHead(200, {
        'content-type': file.mime,
        'content-length': String(file.size),
        'content-disposition': contentDispositionHeader(file.filename),
        'cache-control': 'no-store',
      });
      // HEAD gets headers only (lets the SPA probe availability — see
      // AttachmentRow.tsx's "no longer available" check — without pulling
      // the whole body over the wire).
      res.end(req.method === 'HEAD' ? undefined : file.data);
      return;
    }

    // Files-IN — multipart upload. Auth checked BEFORE anything else (same
    // tokenMatches gate, same query-param convention as /files/ above),
    // before even the method/body is looked at, so a bad token can't be used
    // to probe endpoint behavior.
    if (pathname === '/upload') {
      if (!tokenMatches(token, url.searchParams.get('token'))) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }
      if (req.method !== 'POST') {
        res.writeHead(405, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'method not allowed' }));
        return;
      }
      void handleUpload(req, res);
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

  function handleClientFrame(raw: string, config: ChannelSetup): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw);
    } catch {
      log.warn('Ignoring non-JSON frame from client');
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
      emit({ type: 'message', id: clientId ?? nextId('user'), role: 'user', content: msg.text });

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
      currentConfig = config;

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
        if (!tokenMatches(token, url.searchParams.get('token'))) {
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
            log.info('Web client rejected: bad token');
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
          ws.on('pong', () => aliveClients.set(ws, true));
          log.info('Web client connected', { clients: clients.size });
          // Replay everything we remember BEFORE 'ready', so the SPA rebuilds
          // its conversation before it flips to the connected state — this is
          // what makes a reconnect (dropped socket, or the whole ws layer
          // bouncing) look seamless instead of blank.
          ws.send(JSON.stringify({ type: 'history', frames: history }));
          // Carry the CURRENT typing state so a (re)connecting client starts
          // truthful instead of stuck on whatever `typing` value it had
          // before the drop — typing frames are transient and never land in
          // `history`, so without this a client that missed the one
          // clearing frame (dropped mid-turn, reconnected after the server
          // already went quiet) would show ghost dots forever.
          // P2b: `bundle` is omitted entirely (not sent as null/empty) when
          // there's nothing to report — the SPA's backward-compat contract is
          // "field absent => do nothing", never "field present but falsy".
          const readyFrame: Record<string, unknown> = { type: 'ready', threadId: null, typing: typingState };
          if (currentBundle) readyFrame.bundle = currentBundle;
          ws.send(JSON.stringify(readyFrame));
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

    async deliver(platformId, _threadId, message: OutboundMessage): Promise<string | undefined> {
      if (platformId !== PLATFORM_ID) return undefined;
      const content = (message.content ?? {}) as Record<string, unknown>;

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
            emit({
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
            emit({
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
      setTypingState(false);

      // Normal message — prefer markdown, fall back to text (mirrors the
      // bridge's rawText = content.markdown || content.text).
      const text = (content.markdown as string) || (content.text as string);
      if (text) {
        const messageId = nextId('msg');
        deliveredMessageIds.add(messageId);
        emit({ type: 'message', id: messageId, role: 'assistant', content: text });
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
