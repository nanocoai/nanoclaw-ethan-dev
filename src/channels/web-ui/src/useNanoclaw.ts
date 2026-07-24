import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  ConnectionStatus,
  ConversationItem,
  ServerFrame,
} from './types';

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

  // (Re)connect whenever we hold a token.
  useEffect(() => {
    if (!token) return;

    const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const wsUrl = `${proto}://${window.location.host}/ws?token=${encodeURIComponent(
      token,
    )}`;

    setStatus('connecting');
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;

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
        case 'message':
          setItems((prev) => [
            ...prev,
            {
              kind: 'message',
              id: frame.id,
              role: 'assistant',
              content: frame.content,
            },
          ]);
          break;
        case 'card':
          setItems((prev) => [
            ...prev,
            {
              kind: 'card',
              id: frame.id,
              questionId: frame.questionId,
              title: frame.title,
              question: frame.question,
              options: frame.options,
              pending: false,
            },
          ]);
          break;
        case 'card_resolved':
          setItems((prev) =>
            prev.map((item) =>
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
            ),
          );
          break;
      }
    };

    ws.onclose = (event) => {
      if (event.code === 4401) {
        clearToken();
        setAuthError(true);
        setStatus('disconnected');
        setToken(null);
      } else {
        setStatus('disconnected');
      }
    };

    return () => {
      // Detach handlers so StrictMode's dev double-invoke can't fire stale
      // state updates, then close the socket.
      ws.onopen = null;
      ws.onmessage = null;
      ws.onclose = null;
      ws.onerror = null;
      if (
        ws.readyState === WebSocket.OPEN ||
        ws.readyState === WebSocket.CONNECTING
      ) {
        ws.close();
      }
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [token]);

  const login = useCallback((raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    storeToken(trimmed);
    setAuthError(false);
    setItems([]);
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
    ws.send(
      JSON.stringify({ type: 'action', actionId: `ncq:${questionId}:${index}` }),
    );
    // Immediately mark the card pending so every button is disabled and
    // double-clicks are impossible; the terminal state arrives via card_resolved.
    setItems((prev) =>
      prev.map((item) =>
        item.kind === 'card' && item.questionId === questionId
          ? { ...item, pending: true }
          : item,
      ),
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
