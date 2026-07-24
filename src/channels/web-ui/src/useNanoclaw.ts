import { useCallback, useEffect, useRef, useState } from 'react';
import type { ChatMessage, ConnectionStatus, ConversationItem, ServerFrame } from './types';

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
      const applied: ChatMessage = { kind: 'message', id: frame.id, role: frame.role, content: frame.content };
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
        },
      ];
    case 'edit': {
      // Replace whichever message or card carries this id with a plain
      // assistant message showing the edited content. An id we don't know
      // about gets appended rather than dropped.
      const index = items.findIndex((item) => item.id === frame.id);
      const edited: ChatMessage = { kind: 'message', id: frame.id, role: 'assistant', content: frame.content };
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
  { type: 'ready' } | { type: 'typing' } | { type: 'heartbeat' } | { type: 'history' }
>;

function hasSeq(frame: ServerFrame): frame is SeqFrame {
  return frame.type !== 'ready' && frame.type !== 'typing' && frame.type !== 'heartbeat' && frame.type !== 'history';
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
  status: ConnectionStatus;
  items: ConversationItem[];
  typing: boolean;
  authError: boolean;
  /**
   * P2b: true once this tab has seen the server report a `bundle` that
   * doesn't match its own and has already spent its one automatic reload
   * attempt on it — i.e. the persistent "reload to catch up" banner should
   * show. Never true on a server that omits `bundle` (backward compat) or on
   * the very first mismatch (that one reloads automatically instead).
   */
  bundleStale: boolean;
  login: (token: string) => void;
  sendMessage: (text: string) => void;
  chooseOption: (questionId: string, index: number) => void;
}

export function useNanoclaw(): NanoclawState {
  const [bootstrapped, setBootstrapped] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus>('disconnected');
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [typing, setTyping] = useState(false);
  const [authError, setAuthError] = useState(false);
  const [bundleStale, setBundleStale] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);

  // Every seq-bearing frame this hook instance has ever applied (live or via
  // a history replay), kept sorted by seq — the merge baseline for the next
  // 'history' frame (see mergeHistoryFrames) and the dedupe source for live
  // frames, so replay and live delivery overlapping is always idempotent.
  const frameLogRef = useRef<SeqFrame[]>([]);
  const seenSeqsRef = useRef<Set<number>>(new Set());

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

  // (Re)connect whenever we hold a token. Auto-reconnects on any drop with
  // exponential backoff + jitter, capped at ~30s; a 4401 close (bad/revoked
  // token) is NOT a drop — it clears the token and sends the user back to
  // login instead of retrying forever against a token that will never work.
  useEffect(() => {
    if (!token) return;

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
      const wsUrl = `${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}`;

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
          case 'ready':
            setStatus('connected');
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
          case 'typing':
            applyTyping(frame.on);
            break;
          case 'heartbeat':
            // No-op beyond the armDeadman() above — this frame exists only
            // so the deadman timer has something to see on an otherwise
            // quiet connection. Never carries a `seq`, never touches items.
            break;
          case 'history': {
            // Merge the replay log with whatever this connection already
            // applied live instead of a destructive wholesale replace — see
            // mergeHistoryFrames for why a plain overwrite can lose a live
            // frame that outran the snapshot.
            const merged = mergeHistoryFrames(frameLogRef.current, frame.frames);
            frameLogRef.current = merged;
            seenSeqsRef.current = new Set(merged.map((f) => f.seq));
            setItems(merged.reduce(applyServerFrame, [] as ConversationItem[]));
            break;
          }
          case 'message':
          case 'card':
          case 'generic_card':
          case 'card_resolved':
          case 'edit':
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
          clearToken();
          setAuthError(true);
          setStatus('disconnected');
          setToken(null);
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
  }, [token]);

  const login = useCallback(
    (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      storeToken(trimmed);
      setAuthError(false);
      setItems([]);
      frameLogRef.current = [];
      seenSeqsRef.current = new Set();
      clearTypingTimer();
      setTyping(false);
      setToken(trimmed);
    },
    [clearTypingTimer],
  );

  const sendMessage = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    // Generate the id BEFORE sending and reuse it for both the wire frame and
    // the optimistic local echo below — web.ts echoes this same id back on
    // the recorded MessageFrame, which is what lets applyServerFrame's
    // find-or-append replace this echo in place instead of duplicating it
    // once the server-confirmed (seq-bearing) frame arrives.
    const clientId = `local-${Date.now()}-${Math.round(Math.random() * 1e6)}`;
    ws.send(JSON.stringify({ type: 'user_message', text, clientId }));
    setItems((prev) => [
      ...prev,
      {
        kind: 'message',
        id: clientId,
        role: 'user',
        content: text,
      },
    ]);
  }, []);

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

  return {
    bootstrapped,
    token,
    status,
    items,
    typing,
    authError,
    bundleStale,
    login,
    sendMessage,
    chooseOption,
  };
}
