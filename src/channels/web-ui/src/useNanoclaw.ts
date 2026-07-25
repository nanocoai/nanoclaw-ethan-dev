import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ConnectionStatus, ConversationItem, ServerFrame, SessionSummary } from './types';

/**
 * Pure reducer applying one server frame to the conversation. Used both for
 * live frames as they arrive and (see the 'history' case, item 3) to rebuild
 * the whole conversation from a replayed frame log on reconnect — so both
 * paths agree on what a card_resolved or edit does to the item list.
 */
function applyServerFrame(items: ConversationItem[], frame: ServerFrame): ConversationItem[] {
  switch (frame.type) {
    case 'message': {
      // Find-or-append rather than a blind append: a user's own message
      // frame carries the SAME id as the optimistic local echo sendMessage()
      // already pushed into `items` (see the clientId round-trip in web.ts),
      // so this replaces that echo in place instead of showing it twice.
      // Assistant frames get server-generated ids that never collide with an
      // existing item, so they always fall through to a plain append — no
      // behavior change there.
      const index = items.findIndex((item) => item.id === frame.id);
      const applied: ChatMessage = {
        kind: 'message',
        id: frame.id,
        role: frame.role,
        content: frame.content,
        ts: frame.ts,
      };
      if (index === -1) return [...items, applied];
      const next = items.slice();
      next[index] = applied;
      return next;
    }
    case 'card':
      return [
        ...items,
        {
          kind: 'card',
          id: frame.id,
          questionId: frame.questionId,
          title: frame.title,
          question: frame.question,
          options: frame.options,
          pending: false,
          ts: frame.ts,
        },
      ];
    case 'generic_card':
      return [
        ...items,
        {
          kind: 'generic_card',
          id: frame.id,
          title: frame.title,
          body: frame.body,
          links: frame.links,
          fallbackText: frame.fallbackText,
          ts: frame.ts,
        },
      ];
    case 'card_resolved':
      return items.map((item) =>
        item.kind === 'card' && item.questionId === frame.questionId
          ? {
              ...item,
              pending: false,
              resolution: {
                selectedIndex: frame.selectedIndex,
                selectedLabel: frame.selectedLabel,
                actor: frame.actor,
              },
            }
          : item,
      );
    case 'file':
      return [
        ...items,
        {
          kind: 'file',
          id: frame.id,
          name: frame.name,
          mime: frame.mime,
          size: frame.size,
          downloadPath: frame.downloadPath,
          // Backward compat: a frame from before files-IN existed has no
          // `role` at all — treat that exactly like the pre-existing
          // outbound-only behavior (left-aligned assistant-style card).
          role: frame.role ?? 'assistant',
          ts: frame.ts,
        },
      ];
    case 'edit': {
      // Replace whichever message or card carries this id with a plain
      // assistant message showing the edited content. An id we don't know
      // about gets appended rather than dropped. `ts` reflects the EDIT's
      // own stamp (when the edit landed), not whatever the original
      // message/card carried — the row's displayed time is "when this
      // content became true", which an edit changes.
      const index = items.findIndex((item) => item.id === frame.id);
      const edited: ChatMessage = {
        kind: 'message',
        id: frame.id,
        role: 'assistant',
        content: frame.content,
        ts: frame.ts,
      };
      if (index === -1) return [...items, edited];
      const next = items.slice();
      next[index] = edited;
      return next;
    }
    default:
      return items;
  }
}

/** Frame types that carry a `seq` (everything emit()-recorded server-side). */
type SeqFrame = Exclude<
  ServerFrame,
  | { type: 'ready' }
  | { type: 'typing' }
  | { type: 'heartbeat' }
  | { type: 'history' }
  | { type: 'sessions' }
  | { type: 'session_activity' }
>;

const UNSEQUENCED_FRAME_TYPES = new Set(['ready', 'typing', 'heartbeat', 'history', 'sessions', 'session_activity']);

function hasSeq(frame: ServerFrame): frame is SeqFrame {
  return !UNSEQUENCED_FRAME_TYPES.has(frame.type);
}

/**
 * Merge a replayed 'history' snapshot with whatever seq-bearing frames this
 * connection already applied live. A plain wholesale replace (just
 * `frame.frames.reduce(applyServerFrame, [])`) is NOT safe: if a live frame
 * arrived and was applied before a 'history' snapshot that predates it shows
 * up — a slower snapshot build, a future await added to the connect
 * handshake, a resent/duplicated history frame — that live frame would be
 * silently wiped. Merging by seq (union, sorted, de-duped) makes replay
 * idempotent regardless of arrival order: this is what
 * scripts/repro-history-replace-race.mjs proves the pre-seq reducer gets
 * wrong, and what it proves this merge gets right.
 */
function mergeHistoryFrames(alreadyApplied: SeqFrame[], replayed: ServerFrame[]): SeqFrame[] {
  const bySeq = new Map<number, SeqFrame>();
  for (const frame of alreadyApplied) bySeq.set(frame.seq, frame);
  for (const frame of replayed) if (hasSeq(frame)) bySeq.set(frame.seq, frame);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

// Ghost-typing guard: a browser that misses the single `typing:false`
// clearing frame (typing frames are transient — excluded from `history`
// replay by design, only broadcast on change, see web.ts) would otherwise
// show the animated dots forever. Auto-expire ~12s after the last
// `typing:true` unless a fresh one renews the timer; an explicit
// `typing:false` (live, or applied from the 'ready' frame on reconnect)
// clears it immediately.
const TYPING_TIMEOUT_MS = 12000;

// Half-open-socket deadman: a server restart (or anything that drops the TCP
// connection without a FIN/RST reaching this tab, e.g. the reboot drill that
// found this bug) leaves the browser's WebSocket sitting open with no close
// event ever firing — the SPA looks connected and hears nothing forever.
// Protocol-level pings (web.ts's isAlive pattern) are invisible to JS, so
// instead this timer resets on ANY incoming frame — including the app-level
// `heartbeat` broadcast every ~30s (see types.ts HeartbeatFrame) — and force-
// closes the socket if ~75s pass with nothing at all. A forced close is a
// NORMAL close (not 4401), so it falls straight into the existing
// exponential-backoff reconnect path below rather than needing its own
// recovery logic.
const HEARTBEAT_DEADMAN_MS = 75000;

// P2b stale-bundle detection. Real incident (twice in one day): a tab left
// open across a server deploy keeps its old SPA bundle in memory, then the
// new server starts sending frame shapes that bundle was never built to
// handle (role:user echoes rendered as duplicates once; a `file` frame
// silently unrendered another time). Cache headers (web.ts, no-store on
// index.html) fix a plain reload but can't reach a tab that never reloads.
//
// ownBundleFingerprint() reads THIS tab's own hashed entry-script filename
// straight from the DOM rather than from a build-time constant baked into the
// bundle: a constant baked in at build time would itself be part of the very
// bundle we're trying to detect as stale, so it can only ever describe what
// build the tab shipped WITH, which is exactly what we need to compare
// against the server's `ready.bundle` — but reading the live DOM (rather than
// import.meta.env or similar) means zero build-config coupling and zero risk
// of the two going out of sync, which a hand-maintained constant cannot
// promise (this file's neighbors, e.g. the cache-header fix above, exist
// precisely because a "just remember to bump it" scheme rotted). Note
// `document.currentScript` is unusable here — the spec returns null for
// `<script type="module">`, which is what vite's build emits — so this
// queries the DOM for the script tag directly instead.
function ownBundleFingerprint(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  for (const el of document.querySelectorAll('script[src]')) {
    const src = el.getAttribute('src') ?? '';
    const match = src.match(/\/?(index-[^/?#"]+\.m?js)(?:[?#].*)?$/);
    if (match) return match[1];
  }
  return undefined;
}

// Set right before the ONE automatic reload this tab will ever attempt for a
// bundle mismatch, and read on every subsequent 'ready' frame. This is what
// makes the reload attempt-once instead of loop-forever: sessionStorage
// survives a same-tab reload (unlike component state) but not a fresh
// tab/session, so a genuinely still-mismatched bundle after the reload (two
// deploys landing back to back, or a build that somehow never updates) falls
// straight through to the persistent banner instead of reloading again.
const BUNDLE_RELOAD_ATTEMPTED_KEY = 'nanoclaw_bundle_reload_attempted';

function hasAlreadyAttemptedBundleReload(): boolean {
  try {
    return sessionStorage.getItem(BUNDLE_RELOAD_ATTEMPTED_KEY) === '1';
  } catch {
    // No sessionStorage (private mode, storage disabled) means no way to
    // guarantee a second attempt won't loop — fail safe toward the banner
    // rather than risk reloading forever.
    return true;
  }
}

function markBundleReloadAttempted(): void {
  try {
    sessionStorage.setItem(BUNDLE_RELOAD_ATTEMPTED_KEY, '1');
  } catch {
    /* best-effort; hasAlreadyAttemptedBundleReload() fails safe if this silently no-ops */
  }
}

const TOKEN_KEY = 'nanoclaw_web_token';

function readToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string) {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* ignore storage failures (private mode etc.) */
  }
}

function clearToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

export interface NanoclawState {
  bootstrapped: boolean;
  token: string | null;
  /**
   * WU4: true once this tab knows it needs a token — i.e. a connection
   * attempt was closed 4401. Distinct from `!token`, which no longer implies
   * "show the login screen": a tab with no stored token first ATTEMPTS a bare
   * connect, because a server sitting behind `tailscale serve` with the
   * identity opt-in on authenticates it from the injected header with no
   * token at all (web.ts). Only when that attempt is rejected does the login
   * screen appear, exactly as it always did.
   */
  showLogin: boolean;
  /**
   * The tailnet login this connection was authenticated as, when the server
   * reported one on the `ready` frame (identity auth). null for a
   * token-authenticated connection, and on any server that predates WU4.
   */
  userId: string | null;
  status: ConnectionStatus;
  items: ConversationItem[];
  typing: boolean;
  /**
   * WU3: every conversation the server knows about, already sorted most
   * recently active first (the server sorts; the client does not re-sort, so
   * both agree on what "recent" means). Empty on a pre-sessions server, which
   * is what makes the sidebar render nothing rather than a fake single row.
   */
  sessions: SessionSummary[];
  /** The conversation currently on screen. Always server-confirmed: set from `ready`, then from each history replay. */
  activeSessionId: string | null;
  /** Session ids with activity this client has not looked at yet (the sidebar dot). Cleared on switch. */
  unreadSessionIds: string[];
  newSession: () => void;
  switchSession: (id: string) => void;
  deleteSession: (id: string) => void;
  authError: boolean;
  /**
   * P2b: true once this tab has seen the server report a `bundle` that
   * doesn't match its own and has already spent its one automatic reload
   * attempt on it — i.e. the persistent "reload to catch up" banner should
   * show. Never true on a server that omits `bundle` (backward compat) or on
   * the very first mismatch (that one reloads automatically instead).
   */
  bundleStale: boolean;
  /**
   * Files-IN: the most recent /upload failure's server-reported message
   * (400/413/etc — see web.ts handleUpload), or null once cleared/succeeded.
   * Distinct from a composer's own pre-flight validation (too-many-files,
   * too-big — checked client-side in PromptInput before ever calling
   * sendMessage) — this one is specifically "the server rejected it".
   */
  uploadError: string | null;
  clearUploadError: () => void;
  login: (token: string) => void;
  /** `files` (if any) trigger the multipart /upload path instead of the WS user_message frame — see uploadFiles(). */
  sendMessage: (text: string, files?: File[]) => void;
  chooseOption: (questionId: string, index: number) => void;
}

export function useNanoclaw(): NanoclawState {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [showLogin, setShowLogin] = useState(false);
  const [userId, setUserId] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [typing, setTyping] = useState(false);
  const [authError, setAuthError] = useState(false);
  const [bundleStale, setBundleStale] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [unreadSessionIds, setUnreadSessionIds] = useState<string[]>([]);

  const wsRef = useRef<WebSocket | null>(null);

  // The active session, readable from inside the WS handlers without
  // re-running the connect effect on every switch (which would drop and
  // rebuild the socket for what is purely a view change).
  const activeSessionRef = useRef<string | null>(null);
  const setActiveSession = useCallback((id: string | null) => {
    activeSessionRef.current = id;
    setActiveSessionId(id);
  }, []);

  // Every seq-bearing frame this hook instance has ever applied (live or via
  // a history replay), kept sorted by seq — the merge baseline for the next
  // 'history' frame (see mergeHistoryFrames) and the dedupe source for live
  // frames, so replay and live delivery overlapping is always idempotent.
  const frameLogRef = useRef<SeqFrame[]>([]);
  const seenSeqsRef = useRef<Set<number>>(new Set());

  // Which conversation the frame log above belongs to. `seq` is monotonic
  // WITHIN a session, not across them, so a log carried over from another
  // conversation would merge two numbering spaces into one Map and silently
  // drop frames. A history replay for a different session therefore rebuilds
  // the log from scratch instead of merging into it.
  const logSessionRef = useRef<string | null>(null);

  // Single pending expiry timer for the ghost-typing guard — lives at the
  // hook level (not inside connect()) so it survives a WS reconnect cycle
  // unmolested: a dropped socket alone should NOT reset the countdown, only
  // an explicit typing:false (live or via 'ready') or a fresh typing:true
  // should. Always routed through clearTypingTimer/applyTyping so there is
  // ever at most one live setTimeout — no leak across reconnects or repeated
  // typing:true frames.
  const typingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTypingTimer = useCallback(() => {
    if (typingTimerRef.current !== null) {
      clearTimeout(typingTimerRef.current);
      typingTimerRef.current = null;
    }
  }, []);

  const applyTyping = useCallback(
    (on: boolean) => {
      clearTypingTimer();
      setTyping(on);
      if (on) {
        typingTimerRef.current = setTimeout(() => {
          typingTimerRef.current = null;
          setTyping(false);
        }, TYPING_TIMEOUT_MS);
      }
    },
    [clearTypingTimer],
  );

  // Bootstrap the token exactly once: URL ?token= wins, then localStorage.
  // A URL token is persisted and then stripped from the visible address.
  useEffect(() => {
    let next: string | null = null;
    try {
      const url = new URL(window.location.href);
      const urlToken = url.searchParams.get('token');
      if (urlToken) {
        next = urlToken;
        storeToken(urlToken);
        url.searchParams.delete('token');
        const cleaned = url.pathname + url.search + url.hash;
        window.history.replaceState({}, '', cleaned);
      } else {
        next = readToken();
      }
    } catch {
      next = readToken();
    }
    setToken(next);
    setBootstrapped(true);
  }, []);

  // (Re)connect as soon as the token bootstrap has resolved — WITH the stored
  // token if there is one, and bare (no `?token=`) if there isn't: a server
  // behind `tailscale serve` with the identity opt-in on authenticates that
  // bare connect from the header it was handed, so the login screen must not
  // be assumed before the server has had a chance to say otherwise. Auto-
  // reconnects on any drop with exponential backoff + jitter, capped at ~30s;
  // a 4401 close is NOT a drop — it means this tab genuinely needs a token, so
  // it stops retrying and shows the login screen (clearing the stored token
  // first, if the rejected attempt used one).
  useEffect(() => {
    if (!bootstrapped) return;
    if (showLogin) return;

    let cancelled = false;
    let attempt = 0;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let deadmanTimer: ReturnType<typeof setTimeout> | null = null;

    const clearDeadman = () => {
      if (deadmanTimer !== null) {
        clearTimeout(deadmanTimer);
        deadmanTimer = null;
      }
    };

    const connect = () => {
      if (cancelled) return;

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const base = `${proto}://${window.location.host}/ws`;
      const wsUrl = token ? `${base}?token=${encodeURIComponent(token)}` : base;

      setStatus('connecting');
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      // Re-armed on open and on every frame below; expiry force-closes THIS
      // socket (a plain close, not 4401) so onclose's normal backoff path
      // takes over — see HEARTBEAT_DEADMAN_MS.
      const armDeadman = () => {
        clearDeadman();
        deadmanTimer = setTimeout(() => {
          ws.close();
        }, HEARTBEAT_DEADMAN_MS);
      };
      armDeadman();

      ws.onopen = () => {
        attempt = 0; // a clean connect resets the backoff
        armDeadman();
      };

      ws.onmessage = (event) => {
        // Any frame at all — including the app-level heartbeat — proves the
        // socket is still alive, so reset the deadman before even parsing.
        armDeadman();
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(event.data)) as ServerFrame;
        } catch {
          return;
        }
        switch (frame.type) {
          case 'ready': {
            setStatus('connected');
            // WU3 sidebar state. `?? []` on a pre-sessions server leaves the
            // sidebar empty rather than inventing a row for a conversation
            // the server has no id for.
            setSessions(frame.sessions ?? []);
            if (frame.activeSession) {
              setActiveSession(frame.activeSession);
              setUnreadSessionIds((prev) => prev.filter((id) => id !== frame.activeSession));
            }
            // Identity, when the server has one for this connection. `??
            // null` deliberately RESETS it when the field is absent, so a
            // reconnect that falls back to token auth (or lands on a server
            // without the opt-in) stops showing a login it can no longer
            // vouch for.
            setUserId(frame.userId ?? null);
            // Adopt the server's CURRENT typing state rather than whatever
            // this connection's `typing` was left at before the drop — the
            // ghost-typing fix's other half (see types.ts ReadyFrame.typing
            // and web.ts's ready-frame send).
            applyTyping(frame.typing);

            // P2b stale-bundle check. `frame.bundle` absent (old server) or
            // ownBundleFingerprint() unreadable (can't identify our own
            // script tag) both mean "nothing to compare" — do nothing, per
            // the backward-compat contract. A match means this tab is
            // current — clear any stale banner a PRIOR mismatched connection
            // on this same hook instance might have set.
            if (frame.bundle) {
              const own = ownBundleFingerprint();
              if (own && frame.bundle !== own) {
                if (hasAlreadyAttemptedBundleReload()) {
                  setBundleStale(true);
                } else {
                  markBundleReloadAttempted();
                  window.location.reload();
                  return; // reloading imminently — no point applying more state
                }
              } else {
                setBundleStale(false);
              }
            }
            break;
          }
          case 'sessions':
            setSessions(frame.sessions);
            break;
          case 'session_activity':
            // A conversation this client is NOT viewing moved. Bump its
            // position (the sidebar sorts on lastActiveAt) and dot it. The
            // frames themselves never arrive here by design — switching to
            // the session is what fetches them.
            setSessions((prev) =>
              prev
                .map((session) =>
                  session.id === frame.sessionId ? { ...session, lastActiveAt: frame.lastActiveAt } : session,
                )
                .sort((a, b) => b.lastActiveAt - a.lastActiveAt),
            );
            if (frame.sessionId !== activeSessionRef.current) {
              setUnreadSessionIds((prev) => (prev.includes(frame.sessionId) ? prev : [...prev, frame.sessionId]));
            }
            break;
          case 'typing':
            applyTyping(frame.on);
            break;
          case 'heartbeat':
            // No-op beyond the armDeadman() above — this frame exists only
            // so the deadman timer has something to see on an otherwise
            // quiet connection. Never carries a `seq`, never touches items.
            break;
          case 'history': {
            // A replay for a DIFFERENT conversation (a switch, a create, or a
            // reconnect that landed on another session) starts from an empty
            // baseline: seq only means anything within one session, so
            // merging across them would key two numbering spaces into one
            // Map. Same-session replays keep the existing merge — see
            // mergeHistoryFrames for why a plain overwrite can lose a live
            // frame that outran the snapshot.
            const replaySession = frame.sessionId ?? logSessionRef.current;
            const sameSession = replaySession === logSessionRef.current;
            const merged = mergeHistoryFrames(sameSession ? frameLogRef.current : [], frame.frames);
            frameLogRef.current = merged;
            logSessionRef.current = replaySession ?? null;
            seenSeqsRef.current = new Set(merged.map((f) => f.seq));
            setItems(merged.reduce(applyServerFrame, [] as ConversationItem[]));
            // The server is authoritative about which conversation is on
            // screen: adopt whatever it just replayed, and clear that row's
            // unread dot since it is now, by definition, read.
            if (frame.sessionId) {
              setActiveSession(frame.sessionId);
              setUnreadSessionIds((prev) => prev.filter((id) => id !== frame.sessionId));
            }
            break;
          }
          case 'message':
          case 'card':
          case 'generic_card':
          case 'card_resolved':
          case 'edit':
          case 'file':
            // Belt and braces: the server only routes a recorded frame to
            // clients viewing its session (web.ts routeFrame), so this should
            // never fire — but a frame folded into the wrong conversation is
            // the one failure sessions exist to prevent, so it is checked
            // rather than assumed.
            if (frame.sessionId && activeSessionRef.current && frame.sessionId !== activeSessionRef.current) break;
            // Idempotent on seq: a frame already folded in (live, or via an
            // earlier history merge) is a no-op rather than a duplicate.
            if (seenSeqsRef.current.has(frame.seq)) break;
            seenSeqsRef.current.add(frame.seq);
            frameLogRef.current = [...frameLogRef.current, frame];
            setItems((prev) => applyServerFrame(prev, frame));
            break;
        }
      };

      ws.onclose = (event) => {
        if (wsRef.current === ws) wsRef.current = null;
        clearDeadman();
        if (cancelled) return;

        if (event.code === 4401) {
          // The server wants a token this tab doesn't have. Two shapes:
          //  - the attempt CARRIED a token: it's bad or revoked — clear it and
          //    say so, exactly as before this feature.
          //  - the attempt was bare (identity probe): nothing was wrong with
          //    any token, so no error message — this is just the plain
          //    "enter your access token" screen a tokenless tab always got.
          if (token) {
            clearToken();
            setAuthError(true);
            setToken(null);
          } else {
            setAuthError(false);
          }
          setUserId(null);
          setShowLogin(true);
          setStatus('disconnected');
          return;
        }

        setStatus('disconnected');
        attempt += 1;
        const base = Math.min(30000, 1000 * 2 ** (attempt - 1));
        const jitter = Math.random() * 1000;
        const delay = Math.min(30000, base + jitter);
        reconnectTimer = setTimeout(connect, delay);
      };
    };

    connect();

    return () => {
      cancelled = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      clearDeadman();
      clearTypingTimer();
      const ws = wsRef.current;
      if (ws) {
        // Detach handlers so StrictMode's dev double-invoke can't fire stale
        // state updates, then close the socket.
        ws.onopen = null;
        ws.onmessage = null;
        ws.onclose = null;
        ws.onerror = null;
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close();
        }
        wsRef.current = null;
      }
    };
  }, [bootstrapped, showLogin, token]);

  const login = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      storeToken(trimmed);
      setAuthError(false);
      setShowLogin(false);
      setItems([]);
      frameLogRef.current = [];
      seenSeqsRef.current = new Set();
      logSessionRef.current = null;
      setSessions([]);
      setActiveSession(null);
      setUnreadSessionIds([]);
      clearTypingTimer();
      setTyping(false);
      setToken(trimmed);
    },
    [clearTypingTimer, setActiveSession],
  );

  // Files-IN: POSTs a multipart /upload (token in the query string, same
  // convention as the WS upgrade and the /files/ download route — and, like
  // both of those, omitted entirely when this tab has no token, so the
  // server authenticates the request from the Tailscale header instead). No
  // optimistic local echo here — unlike the plain-text WS path below, the
  // user's message-bubble AND each file row all arrive as ordinary emit()'d
  // frames over THIS SAME already-open WS connection (web.ts handleUpload:
  // a 'message' frame for the caption, then a 'file' frame per upload,
  // role:'user') — unavoidably as good as instant, and one fewer place that
  // could duplicate/diverge from what the server actually recorded.
  const uploadFiles = useCallback(
    async (text: string, files: File[]) => {
      setUploadError(null);
      try {
        const form = new FormData();
        if (text) form.append('text', text);
        for (const file of files) form.append('file', file, file.name);
        // `sessionId` rides the query string next to the token (same
        // convention as /files/ and the WS upgrade) so an upload lands in the
        // conversation on screen, not in whatever the server last considered
        // active — the HTTP path has no WebSocket to infer a view from.
        const params = new URLSearchParams();
        if (token) params.set('token', token);
        if (activeSessionRef.current) params.set('sessionId', activeSessionRef.current);
        const query = params.toString();
        const url = query ? `/upload?${query}` : '/upload';
        const res = await fetch(url, {
          method: 'POST',
          body: form,
        });
        if (!res.ok) {
          let message = `upload failed (${res.status})`;
          try {
            const body: unknown = await res.json();
            if (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string') {
              message = (body as { error: string }).error;
            }
          } catch {
            // non-JSON error body — fall back to the generic status message above
          }
          setUploadError(message);
        }
      } catch {
        setUploadError('upload failed — network error');
      }
    },
    [token],
  );

  const sendMessage = useCallback(
    (text: string, files: File[] = []) => {
      if (files.length > 0) {
        void uploadFiles(text, files);
        return;
      }
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Generate the id BEFORE sending and reuse it for both the wire frame and
      // the optimistic local echo below — web.ts echoes this same id back on
      // the recorded MessageFrame, which is what lets applyServerFrame's
      // find-or-append replace this echo in place instead of duplicating it
      // once the server-confirmed (seq-bearing) frame arrives.
      const clientId = `local-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
      // `sessionId` is sent explicitly even though the server would fall back
      // to this connection's view anyway: the explicit id is what makes a
      // message impossible to misfile if the two ever disagree (a switch
      // still in flight, a second tab).
      const sessionId = activeSessionRef.current ?? undefined;
      ws.send(JSON.stringify({ type: 'user_message', text, clientId, ...(sessionId ? { sessionId } : {}) }));
      setItems((prev) => [
        ...prev,
        {
          kind: 'message',
          id: clientId,
          role: 'user',
          content: text,
        },
      ]);
    },
    [uploadFiles],
  );

  const chooseOption = useCallback((questionId: string, index: number) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'action', actionId: `ncq:${questionId}:${index}` }));
    // Immediately mark the card pending so every button is disabled and
    // double-clicks are impossible; the terminal state arrives via card_resolved.
    setItems((prev) =>
      prev.map((item) => (item.kind === 'card' && item.questionId === questionId ? { ...item, pending: true } : item)),
    );
  }, []);

  const clearUploadError = useCallback(() => setUploadError(null), []);

  /**
   * Clear the on-screen conversation while a switch/create is in flight. The
   * server answers with a history replay that names the session; showing the
   * PREVIOUS conversation until it lands would be showing the wrong chat
   * under the new title, which is worse than showing an empty pane for one
   * round trip.
   */
  const resetConversationForSwitch = useCallback(() => {
    setItems([]);
    frameLogRef.current = [];
    seenSeqsRef.current = new Set();
    logSessionRef.current = null;
    clearTypingTimer();
    setTyping(false);
  }, [clearTypingTimer]);

  const newSession = useCallback(() => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    resetConversationForSwitch();
    setActiveSession(null); // the id only exists once the server creates it
    ws.send(JSON.stringify({ type: 'create_session' }));
  }, [resetConversationForSwitch, setActiveSession]);

  const switchSession = useCallback(
    (id: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (id === activeSessionRef.current) return;
      resetConversationForSwitch();
      setActiveSession(id);
      setUnreadSessionIds((prev) => prev.filter((sessionId) => sessionId !== id));
      ws.send(JSON.stringify({ type: 'switch_session', id }));
    },
    [resetConversationForSwitch, setActiveSession],
  );

  const deleteSession = useCallback(
    (id: string) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      // Deleting the conversation on screen leaves the pane empty until the
      // server replays whichever one it moved this client to; deleting any
      // other one leaves the current view untouched.
      if (id === activeSessionRef.current) resetConversationForSwitch();
      setUnreadSessionIds((prev) => prev.filter((sessionId) => sessionId !== id));
      ws.send(JSON.stringify({ type: 'delete_session', id }));
    },
    [resetConversationForSwitch],
  );

  return {
    bootstrapped,
    token,
    showLogin,
    userId,
    status,
    items,
    typing,
    sessions,
    activeSessionId,
    unreadSessionIds,
    newSession,
    switchSession,
    deleteSession,
    authError,
    bundleStale,
    uploadError,
    clearUploadError,
    login,
    sendMessage,
    chooseOption,
  };
}
