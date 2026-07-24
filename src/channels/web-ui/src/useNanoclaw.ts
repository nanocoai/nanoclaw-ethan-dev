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
    case 'message':
      return [...items, { kind: 'message', id: frame.id, role: 'assistant', content: frame.content }];
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
type SeqFrame = Exclude<ServerFrame, { type: 'ready' } | { type: 'typing' } | { type: 'history' }>;

function hasSeq(frame: ServerFrame): frame is SeqFrame {
  return frame.type !== 'ready' && frame.type !== 'typing' && frame.type !== 'history';
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

  const wsRef = useRef<WebSocket | null>(null);

  // Every seq-bearing frame this hook instance has ever applied (live or via
  // a history replay), kept sorted by seq — the merge baseline for the next
  // 'history' frame (see mergeHistoryFrames) and the dedupe source for live
  // frames, so replay and live delivery overlapping is always idempotent.
  const frameLogRef = useRef<SeqFrame[]>([]);
  const seenSeqsRef = useRef<Set<number>>(new Set());

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

    const connect = () => {
      if (cancelled) return;

      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const wsUrl = `${proto}://${window.location.host}/ws?token=${encodeURIComponent(token)}`;

      setStatus('connecting');
      const ws = new WebSocket(wsUrl);
      wsRef.current = ws;

      ws.onopen = () => {
        attempt = 0; // a clean connect resets the backoff
      };

      ws.onmessage = (event) => {
        let frame: ServerFrame;
        try {
          frame = JSON.parse(String(event.data)) as ServerFrame;
        } catch {
          return;
        }
        switch (frame.type) {
          case 'ready':
            setStatus('connected');
            break;
          case 'typing':
            setTyping(frame.on);
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

  const login = useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    storeToken(trimmed);
    setAuthError(false);
    setItems([]);
    frameLogRef.current = [];
    seenSeqsRef.current = new Set();
    setTyping(false);
    setToken(trimmed);
  }, []);

  const sendMessage = useCallback((text: string) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'user_message', text }));
    setItems((prev) => [
      ...prev,
      {
        kind: 'message',
        id: `local-${Date.now()}-${Math.round(Math.random() * 1e6)}`,
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
    login,
    sendMessage,
    chooseOption,
  };
}
