/**
 * Outbound message operations (container side).
 *
 * Writes to outbound.db (container-owned).
 * The host polls this DB (read-only) for undelivered messages.
 */
import { getInboundDb, getOutboundDb } from './connection.js';

export interface MessageOutRow {
  id: string;
  seq: number | null;
  in_reply_to: string | null;
  timestamp: string;
  deliver_after: string | null;
  recurrence: string | null;
  kind: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  content: string;
}

export interface WriteMessageOut {
  id: string;
  in_reply_to?: string | null;
  deliver_after?: string | null;
  recurrence?: string | null;
  kind: string;
  platform_id?: string | null;
  channel_type?: string | null;
  thread_id?: string | null;
  content: string;
}

/**
 * Write a new outbound message, auto-assigning an odd seq number.
 * Container uses odd seq (1, 3, 5...), host uses even (2, 4, 6...).
 *
 * The disjoint namespace is load-bearing, not just collision avoidance:
 * seq is the agent-facing message ID returned by send_message and accepted
 * by edit_message / add_reaction, and getMessageIdBySeq() below looks up
 * by seq across BOTH tables. If inbound and outbound could share a seq,
 * the agent's "edit message #5" could resolve to the wrong row.
 */
export function writeMessageOut(msg: WriteMessageOut): number {
  const outbound = getOutboundDb();
  const inbound = getInboundDb();

  // Read max seq from both DBs to maintain global ordering.
  // Safe: each side only reads the other DB, never writes to it.
  const maxOut = (outbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
  const maxIn = (inbound.prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_in').get() as { m: number }).m;
  const max = Math.max(maxOut, maxIn);
  const nextSeq = max % 2 === 0 ? max + 1 : max + 2; // next odd

  // bun:sqlite requires named parameters to be passed with the prefix character
  // in the JS object keys (better-sqlite3 auto-stripped it, bun:sqlite does not).
  outbound
    .prepare(
      `INSERT INTO messages_out (id, seq, in_reply_to, timestamp, deliver_after, recurrence, kind, platform_id, channel_type, thread_id, content)
     VALUES ($id, $seq, $in_reply_to, $timestamp, $deliver_after, $recurrence, $kind, $platform_id, $channel_type, $thread_id, $content)`,
    )
    .run({
      $id: msg.id,
      $seq: nextSeq,
      $timestamp: new Date().toISOString(),
      $in_reply_to: msg.in_reply_to ?? null,
      $deliver_after: msg.deliver_after ?? null,
      $recurrence: msg.recurrence ?? null,
      $kind: msg.kind,
      $platform_id: msg.platform_id ?? null,
      $channel_type: msg.channel_type ?? null,
      $thread_id: msg.thread_id ?? null,
      $content: msg.content,
    });

  return nextSeq;
}

/**
 * Look up a message's platform ID by seq number.
 * Searches both inbound and outbound DBs since seq spans both.
 *
 * For inbound messages, the Chat SDK message ID is already the platform message ID
 * (e.g., "6037840640:42" for Telegram).
 *
 * For outbound messages, the internal ID (msg-xxx) won't work for edits/reactions.
 * Instead, look up the platform_message_id from the delivered table (host writes this
 * after successful delivery).
 */
export function getMessageIdBySeq(seq: number): string | null {
  const inbound = getInboundDb();

  // Inbound messages: ID is already the platform message ID
  const inRow = inbound.prepare('SELECT id FROM messages_in WHERE seq = ?').get(seq) as { id: string } | undefined;
  if (inRow) return inRow.id;

  // Outbound messages: look up platform message ID from delivered table
  const outRow = getOutboundDb().prepare('SELECT id FROM messages_out WHERE seq = ?').get(seq) as
    | { id: string }
    | undefined;
  if (!outRow) return null;

  // Check if host has stored the platform message ID after delivery
  const deliveredRow = inbound
    .prepare('SELECT platform_message_id FROM delivered WHERE message_out_id = ?')
    .get(outRow.id) as { platform_message_id: string | null } | undefined;
  if (deliveredRow?.platform_message_id) return deliveredRow.platform_message_id;

  // Fallback to internal ID (edits/reactions on undelivered messages won't work)
  return outRow.id;
}

/**
 * Look up the routing fields for a message by seq (for edit/reaction targeting).
 * Returns the channel_type, platform_id, thread_id of the referenced message.
 */
export function getRoutingBySeq(
  seq: number,
): { channel_type: string | null; platform_id: string | null; thread_id: string | null } | null {
  const inbound = getInboundDb();
  const inRow = inbound
    .prepare('SELECT channel_type, platform_id, thread_id FROM messages_in WHERE seq = ?')
    .get(seq) as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  if (inRow) return inRow;

  const outRow = getOutboundDb()
    .prepare('SELECT channel_type, platform_id, thread_id FROM messages_out WHERE seq = ?')
    .get(seq) as { channel_type: string | null; platform_id: string | null; thread_id: string | null } | undefined;
  return outRow ?? null;
}

/**
 * Highest seq currently in messages_out. Used by the poll-loop to snapshot a
 * per-turn baseline: MCP tools (send_message, send_file, …) write outbound rows
 * directly and never touch the in-process `sent` counter, so a turn that
 * answered via a tool then ended with bare scratchpad looks identical to a
 * silent drop. Comparing this against a turn-start baseline reveals whether the
 * agent actually delivered anything out-of-band before the never-silent
 * fallback fires. Reads outbound only — inbound activity never moves it.
 */
export function getMaxOutboundSeq(): number {
  return (getOutboundDb().prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM messages_out').get() as { m: number }).m;
}

/**
 * Highest seq ABOVE `sinceSeq` on a row that put new content in front of a
 * person, or 0 when there is none.
 *
 * Narrower than getMaxOutboundSeq on purpose. Several outbound kinds move the
 * seq without answering anyone: `system` rows are internal bookkeeping,
 * `task_log` rows go to a run log, and an edit or a reaction rides on a `chat`
 * row while only annotating a message that already exists. Counting any of
 * those as an answer would let a turn that merely reacted pass as a reply,
 * leaving whoever asked with nothing.
 *
 * One call answers both "did anything land?" and "what is the new baseline?".
 * Reading those separately let a row committed by an out-of-process tool
 * between the two reads be absorbed into the baseline without ever counting as
 * a delivery. The scan is bounded by the caller's baseline; the cap only bites
 * on a pathological run of annotations, where returning 0 errs toward chasing
 * the turn rather than going quiet.
 */
const DELIVERY_SCAN_LIMIT = 200;

export function getDeliveredSeqSince(sinceSeq: number): number {
  const rows = getOutboundDb()
    .prepare(
      `SELECT seq, content FROM messages_out
       WHERE kind IN ('chat', 'chat-sdk') AND seq > ?
       ORDER BY seq DESC
       LIMIT ${DELIVERY_SCAN_LIMIT}`,
    )
    .all(sinceSeq) as Array<{ seq: number; content: string }>;
  for (const row of rows) {
    if (isNewUserContent(row.content)) return row.seq;
  }
  return 0;
}

/** False for the operations that annotate an existing message. */
function isNewUserContent(content: string): boolean {
  try {
    const parsed = JSON.parse(content) as { operation?: string };
    return parsed.operation !== 'edit' && parsed.operation !== 'reaction';
  } catch {
    // A chat row we cannot parse is still a delivery the host will act on;
    // counting it avoids following a real reply with a redundant notice.
    return true;
  }
}

/**
 * Seq of an already-written chat row carrying the same text to the same
 * destination within the same turn, or null when there is none.
 *
 * `sinceSeq` is what scopes the lookup to one turn: it is the outbound baseline
 * the poll loop publishes when a turn starts, so only rows written during this
 * turn can match, and the same short answer given again an hour later counts as
 * a new message rather than a repeat. The in_reply_to stamp cannot serve as that
 * anchor — it is set when a query opens and is not refreshed when a follow-up
 * batch is pushed into a still-open query, so in a long-lived query it would
 * scope "this turn" to the whole life of the container.
 *
 * Scheduled rows (`deliver_after`) are excluded — those are queued for a later
 * moment and a same-text pair is legitimate.
 *
 * Routing is matched with `IS` rather than `=` because platform_id, channel_type
 * and thread_id are all nullable, and SQL equality against NULL is never true:
 * with `=`, two agent-channel sends with no thread would fail to match and the
 * duplicate would go out.
 *
 * The text comparison is trimmed, so whitespace-only variation still reads as
 * the same message. Rows whose content is not JSON, or carries no text, describe
 * something other than a plain chat send and are skipped.
 *
 * The scan is capped: past the cap the answer is "no duplicate", which delivers
 * a repeat rather than silently swallowing a distinct message.
 */
const DUPLICATE_SCAN_LIMIT = 100;

export function findDuplicateChatSend(opts: {
  sinceSeq: number;
  platformId: string | null;
  channelType: string | null;
  threadId: string | null;
  text: string;
}): number | null {
  const rows = getOutboundDb()
    .prepare(
      `SELECT seq, content FROM messages_out
       WHERE kind = 'chat'
         AND deliver_after IS NULL
         AND seq > $since
         AND platform_id IS $platform_id
         AND channel_type IS $channel_type
         AND thread_id IS $thread_id
       ORDER BY seq DESC
       LIMIT ${DUPLICATE_SCAN_LIMIT}`,
    )
    .all({
      $since: opts.sinceSeq,
      $platform_id: opts.platformId,
      $channel_type: opts.channelType,
      $thread_id: opts.threadId,
    }) as Array<{ seq: number | null; content: string }>;

  const wanted = opts.text.trim();
  for (const row of rows) {
    if (row.seq === null) continue;
    let text: unknown;
    try {
      text = (JSON.parse(row.content) as { text?: unknown }).text;
    } catch {
      continue;
    }
    if (typeof text === 'string' && text.trim() === wanted) return row.seq;
  }
  return null;
}

/** Get undelivered messages (for host polling — reads from outbound.db). */
export function getUndeliveredMessages(): MessageOutRow[] {
  return getOutboundDb()
    .prepare(
      `SELECT * FROM messages_out
       WHERE (deliver_after IS NULL OR datetime(deliver_after) <= datetime('now'))
       ORDER BY timestamp ASC`,
    )
    .all() as MessageOutRow[];
}
