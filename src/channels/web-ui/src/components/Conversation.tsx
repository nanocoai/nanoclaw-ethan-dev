import { useEffect, useMemo, useRef } from 'react';
import type { ConversationItem } from '../types';
import { Message } from './Message';
import { ApprovalCard } from './ApprovalCard';
import { GenericCard } from './GenericCard';
import { AttachmentRow } from './AttachmentRow';
import { TypingDots } from './TypingDots';
import { DateSeparator } from './DateSeparator';
import { isSameLocalDay, formatDateSeparator } from '../time';

/** A date-separator row interleaved between conversation items. */
interface SeparatorRow {
  row: 'separator';
  key: string;
  label: string;
}

type RenderRow = { row: 'item'; item: ConversationItem } | SeparatorRow;

/**
 * Interleave date-separator rows wherever the local calendar day changes
 * between consecutive TIMESTAMPED items. Items without a `ts` (backward-compat
 * — see types.ts) are rendered in place but never themselves trigger a
 * separator and never reset the "last seen day" — so a single untimestamped
 * item in the middle of a run doesn't spuriously split it.
 */
function withDateSeparators(items: ConversationItem[]): RenderRow[] {
  const rows: RenderRow[] = [];
  let lastTs: number | undefined;
  for (const item of items) {
    const ts = 'ts' in item ? item.ts : undefined;
    if (ts !== undefined && (lastTs === undefined || !isSameLocalDay(lastTs, ts))) {
      rows.push({ row: 'separator', key: `sep-${item.kind}-${item.id}`, label: formatDateSeparator(ts) });
    }
    if (ts !== undefined) lastTs = ts;
    rows.push({ row: 'item', item });
  }
  return rows;
}

export function Conversation({
  items,
  typing,
  connected,
  token,
  onChoose,
}: {
  items: ConversationItem[];
  typing: boolean;
  connected: boolean;
  token: string | null;
  onChoose: (questionId: string, index: number) => void;
}) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to the bottom on any new frame (message, card, or typing).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [items, typing]);

  const empty = items.length === 0 && !typing;
  const rows = useMemo(() => withDateSeparators(items), [items]);

  return (
    <div ref={scrollRef} className="scroll-area flex-1 overflow-y-auto">
      <div className="mx-auto flex min-h-full w-full max-w-3xl flex-col justify-end py-6">
        {empty ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 px-4 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-indigo-400">
              <span className="h-2.5 w-2.5 rounded-full bg-indigo-400" />
            </div>
            <p className="text-sm text-zinc-400">
              {connected
                ? 'connected — say something to get started'
                : 'waiting for the connection'}
            </p>
          </div>
        ) : (
          <>
            {rows.map((row) => {
              if (row.row === 'separator') {
                return <DateSeparator key={row.key} label={row.label} />;
              }
              const item = row.item;
              if (item.kind === 'message') {
                return <Message key={item.id} message={item} />;
              }
              if (item.kind === 'card') {
                return (
                  <ApprovalCard
                    key={item.id}
                    card={item}
                    onChoose={onChoose}
                    disabled={!connected}
                  />
                );
              }
              if (item.kind === 'file') {
                return <AttachmentRow key={item.id} file={item} token={token} />;
              }
              // generic_card — if there's nothing renderable (no title, no
              // body, no links), fall back to plain text rather than
              // showing an empty card shell.
              const renderable = Boolean(item.title) || item.body.length > 0 || item.links.length > 0;
              if (!renderable) {
                return (
                  <Message
                    key={item.id}
                    message={{ kind: 'message', id: item.id, role: 'assistant', content: item.fallbackText }}
                  />
                );
              }
              return <GenericCard key={item.id} card={item} />;
            })}
            {typing && <TypingDots />}
          </>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
