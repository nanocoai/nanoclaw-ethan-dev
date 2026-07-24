// Wire protocol shared with the backend web-channel adapter.

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export type OptionStyle = 'primary' | 'danger' | 'default';

export interface CardOption {
  index: number;
  label: string;
  value: string;
  style?: OptionStyle;
  selectedLabel?: string;
}

/** Resolution state stamped onto a card once a choice is made. */
export interface CardResolution {
  selectedIndex: number;
  selectedLabel: string;
  actor: string;
}

// ---- Server -> client frames ----

export interface ReadyFrame {
  type: 'ready';
  threadId: string | null;
  /**
   * Current server-side typing state at connect time. Typing frames are
   * transient (never recorded into `history`), so a (re)connecting client
   * needs this to start truthful instead of carrying over whatever `typing`
   * value it had before the drop — see useNanoclaw.ts's 'ready' handling.
   */
  typing: boolean;
  /**
   * P2b stale-bundle detection: the served SPA's own hashed entry-script
   * filename (e.g. `index-BCC2gOvE.js`), read server-side off index.html at
   * setup() time (web.ts readBundleFingerprint). Absent entirely on a server
   * that predates this feature — that absence must trigger NOTHING client
   * side (see useNanoclaw.ts), never be treated as "mismatch".
   */
  bundle?: string;
}

export interface TypingFrame {
  type: 'typing';
  on: boolean;
}

/**
 * App-level heartbeat, broadcast every ~30s (web.ts). Browsers cannot
 * observe protocol-level WS pings from JS, so this frame is what the
 * client's deadman timer actually watches for — see useNanoclaw.ts. Carries
 * no `seq`: it is never recorded into replay history (server-side emit() is
 * bypassed entirely for this frame), so it must not appear in a 'history'
 * replay and must not affect merge/dedupe logic below.
 */
export interface HeartbeatFrame {
  type: 'heartbeat';
}

// `seq` is a monotonically increasing frame counter stamped server-side
// (web.ts emit()) on every frame that gets recorded into replay history —
// everything below except TypingFrame/ReadyFrame/HistoryFrame itself. The
// client reducer uses it to merge a replayed 'history' snapshot with
// whatever it already applied live, instead of a destructive overwrite —
// see useNanoclaw.ts applyServerFrame / mergeHistoryFrames.

export interface MessageFrame {
  type: 'message';
  id: string;
  role: 'assistant' | 'user';
  content: string;
  seq: number;
}

export interface CardFrame {
  type: 'card';
  id: string;
  questionId: string;
  title: string;
  question: string;
  options: CardOption[];
  seq: number;
}

export interface CardResolvedFrame {
  type: 'card_resolved';
  questionId: string;
  selectedIndex: number;
  selectedLabel: string;
  actor: string;
  seq: number;
}

/** A link-style action on a generic card — opens a URL, never round-trips. */
export interface CardLink {
  label: string;
  url: string;
  style?: OptionStyle;
}

/**
 * Generic display card (the `send_card` MCP tool), as opposed to CardFrame's
 * interactive ask_question. No callback buttons — fire-and-forget, matching
 * the Chat SDK bridge's `content.type === 'card'` branch.
 */
export interface GenericCardFrame {
  type: 'generic_card';
  id: string;
  title: string;
  body: string[];
  links: CardLink[];
  fallbackText: string;
  seq: number;
}

/**
 * In-place edit of a previously delivered message or card — mirrors the
 * Chat SDK bridge's operation:'edit' (e.g. an approval expiring in place).
 * `id` is unscoped over both plain messages and cards: whichever
 * conversation item carries that id gets replaced with a plain assistant
 * message showing `content`. An unknown id (nothing in the conversation has
 * it) gets appended instead of dropped.
 */
export interface EditFrame {
  type: 'edit';
  id: string;
  content: string;
  seq: number;
}

/**
 * Outbound file attachment (P2a). `id` doubles as the attachment's registry
 * id server-side — `downloadPath` is literally `/files/<id>` (web.ts) — so
 * there's a single id to track, not a separate message-id/file-id pair.
 * `mime` is server-derived from the filename extension (OutboundFile itself
 * carries no mime type, see adapter.ts).
 */
export interface FileFrame {
  type: 'file';
  id: string;
  name: string;
  mime: string;
  size: number;
  downloadPath: string;
  seq: number;
}

export type ServerFrame =
  | ReadyFrame
  | TypingFrame
  | HeartbeatFrame
  | MessageFrame
  | CardFrame
  | CardResolvedFrame
  | GenericCardFrame
  | EditFrame
  | FileFrame
  | HistoryFrame;

/**
 * Replay of the server's bounded frame ring buffer, sent right after a
 * connection opens (before `ready`) so a reconnecting client rebuilds the
 * whole conversation instead of starting blank. `frames` never itself
 * contains a `history` frame — it's the raw log of everything else that was
 * ever emitted, replayed in order through the same reducer as live frames.
 */
export interface HistoryFrame {
  type: 'history';
  frames: ServerFrame[];
}

// ---- Client -> server frames ----

export interface UserMessageFrame {
  type: 'user_message';
  text: string;
  /**
   * Client-generated id for this send. The server echoes it back as the `id`
   * on the MessageFrame it records for replay, so the client's own optimistic
   * local echo (see useNanoclaw.ts sendMessage) and the server-confirmed copy
   * carry the same id and dedupe cleanly instead of rendering twice.
   */
  clientId?: string;
}

export interface ActionFrame {
  type: 'action';
  actionId: string; // "ncq:<questionId>:<index>"
}

export type ClientFrame = UserMessageFrame | ActionFrame;

// ---- Local conversation model ----

export interface ChatMessage {
  kind: 'message';
  id: string;
  role: 'assistant' | 'user';
  content: string;
}

export interface ChatCard {
  kind: 'card';
  id: string;
  questionId: string;
  title: string;
  question: string;
  options: CardOption[];
  /** true once an option has been clicked but before card_resolved arrives. */
  pending: boolean;
  /** present once the card has reached its terminal chosen state. */
  resolution?: CardResolution;
}

export interface ChatGenericCard {
  kind: 'generic_card';
  id: string;
  title: string;
  body: string[];
  links: CardLink[];
  fallbackText: string;
}

export interface ChatFile {
  kind: 'file';
  id: string;
  name: string;
  mime: string;
  size: number;
  downloadPath: string;
}

export type ConversationItem = ChatMessage | ChatCard | ChatGenericCard | ChatFile;
