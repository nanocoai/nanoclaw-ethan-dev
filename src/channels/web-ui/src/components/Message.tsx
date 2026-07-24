import clsx from 'clsx';
import type { ChatMessage } from '../types';
import { Markdown } from './Markdown';

/** Small assistant identity dot, reused by the typing indicator. */
export function AssistantAvatar() {
  return (
    <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-zinc-800 bg-zinc-900 text-indigo-400">
      <span className="h-2 w-2 rounded-full bg-indigo-400" />
    </div>
  );
}

export function Message({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user';

  if (isUser) {
    return (
      <div
        className="nano-fade-in flex w-full justify-end px-4 py-2"
        data-testid="message"
        data-role="user"
      >
        <div className="max-w-[75%] whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm border border-zinc-700/60 bg-zinc-800/70 px-4 py-2.5 text-[15px] leading-relaxed text-zinc-100">
          {message.content}
        </div>
      </div>
    );
  }

  return (
    <div
      className={clsx('nano-fade-in flex w-full items-start gap-3 px-4 py-2')}
      data-testid="message"
      data-role="assistant"
    >
      <AssistantAvatar />
      <div className="min-w-0 max-w-[80%] pt-0.5">
        <Markdown content={message.content} />
      </div>
    </div>
  );
}
