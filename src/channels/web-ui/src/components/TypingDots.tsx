import { AssistantAvatar } from './Message';

/** Assistant "streaming" indicator: an avatar plus three bouncing dots. */
export function TypingDots() {
  return (
    <div className="nano-fade-in flex w-full items-start gap-3 px-4 py-2" data-testid="typing">
      <AssistantAvatar />
      <div className="flex items-center gap-1.5 rounded-2xl rounded-tl-sm border border-zinc-800 bg-zinc-900/70 px-4 py-3">
        <span className="nano-dot h-1.5 w-1.5 rounded-full bg-indigo-400" style={{ animationDelay: '0ms' }} />
        <span className="nano-dot h-1.5 w-1.5 rounded-full bg-indigo-400" style={{ animationDelay: '160ms' }} />
        <span className="nano-dot h-1.5 w-1.5 rounded-full bg-indigo-400" style={{ animationDelay: '320ms' }} />
      </div>
    </div>
  );
}
