import { useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';

export function PromptInput({
  disabled,
  onSend,
}: {
  disabled: boolean;
  onSend: (text: string) => void;
}) {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Grow the textarea with its content, up to a sensible cap.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
  };

  const canSend = value.trim().length > 0 && !disabled;

  return (
    <div className="border-t border-zinc-800/80 bg-zinc-950/80 px-4 py-3 backdrop-blur">
      <div className="mx-auto w-full max-w-3xl">
        <div
          className={clsx(
            'flex items-end gap-2 rounded-2xl border bg-zinc-900/70 px-3 py-2 transition-colors',
            'border-zinc-800 focus-within:border-zinc-600 focus-within:ring-1 focus-within:ring-zinc-600',
            disabled && 'opacity-60',
          )}
        >
          <textarea
            ref={textareaRef}
            data-testid="composer-input"
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={disabled ? 'disconnected' : 'message nanoclaw…'}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            className="max-h-[180px] flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:cursor-not-allowed"
          />
          <button
            type="button"
            data-testid="send-button"
            aria-label="send"
            disabled={!canSend}
            onClick={submit}
            className={clsx(
              'mb-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950',
              canSend
                ? 'bg-indigo-500 text-white hover:bg-indigo-400'
                : 'cursor-not-allowed bg-zinc-800 text-zinc-600',
            )}
          >
            <svg
              viewBox="0 0 20 20"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10 16V4M10 4l-5 5M10 4l5 5" />
            </svg>
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-zinc-600">
          enter to send · shift + enter for a new line
        </p>
      </div>
    </div>
  );
}
