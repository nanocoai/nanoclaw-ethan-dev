import { useEffect, useRef } from 'react';
import type { ConversationItem } from '../types';
import { Message } from './Message';
import { ApprovalCard } from './ApprovalCard';
import { TypingDots } from './TypingDots';

export function Conversation({
  items,
  typing,
  connected,
  onChoose,
}: {
  items: ConversationItem[];
  typing: boolean;
  connected: boolean;
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
            {items.map((item) =>
              item.kind === 'message' ? (
                <Message key={item.id} message={item} />
              ) : (
                <ApprovalCard
                  key={item.id}
                  card={item}
                  onChoose={onChoose}
                  disabled={!connected}
                />
              ),
            )}
            {typing && <TypingDots />}
          </>
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
