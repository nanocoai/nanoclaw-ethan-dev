import clsx from 'clsx';
import type { ChatCard, OptionStyle } from '../types';

function optionClasses(style: OptionStyle | undefined, disabled: boolean) {
  const base =
    'inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950 disabled:cursor-not-allowed';
  if (disabled) {
    return clsx(
      base,
      'border border-zinc-800 bg-zinc-900 text-zinc-600 opacity-60',
    );
  }
  switch (style) {
    case 'primary':
      return clsx(
        base,
        'bg-indigo-500 text-white hover:bg-indigo-400 focus-visible:ring-indigo-400',
      );
    case 'danger':
      return clsx(
        base,
        'border border-rose-500/60 bg-rose-500/10 text-rose-300 hover:bg-rose-500/20 focus-visible:ring-rose-500',
      );
    default:
      return clsx(
        base,
        'border border-zinc-700 bg-zinc-800/60 text-zinc-200 hover:bg-zinc-800 focus-visible:ring-zinc-500',
      );
  }
}

export function ApprovalCard({
  card,
  onChoose,
  disabled,
}: {
  card: ChatCard;
  onChoose: (questionId: string, index: number) => void;
  disabled: boolean;
}) {
  const resolved = card.resolution;

  return (
    <div className="nano-fade-in flex w-full px-4 py-2">
      <div
        className="w-full max-w-[80%] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/70 shadow-[0_1px_0_0_rgba(255,255,255,0.02)_inset]"
        data-testid="approval-card"
        data-question-id={card.questionId}
        data-resolved={resolved ? 'true' : 'false'}
      >
        <div className="border-b border-zinc-800/80 bg-zinc-900/40 px-4 py-2.5">
          <span className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500">
            {card.title}
          </span>
        </div>

        <div className="px-4 py-4">
          <p className="text-[15px] font-medium leading-relaxed text-zinc-100">
            {card.question}
          </p>

          {resolved ? (
            <div
              className="mt-4 flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-950/40 px-3 py-2.5 text-sm text-zinc-200"
              data-testid="card-resolved"
            >
              <svg
                viewBox="0 0 20 20"
                className="h-4 w-4 shrink-0 text-indigo-400"
                fill="none"
                stroke="currentColor"
                strokeWidth={2}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 10.5l4 4 8-9" />
              </svg>
              <span className="font-medium text-zinc-100">
                {resolved.selectedLabel}
              </span>
              <span className="text-zinc-500">— {resolved.actor}</span>
            </div>
          ) : (
            <div className="mt-4 flex flex-wrap gap-2">
              {card.options.map((option) => (
                <button
                  key={option.index}
                  type="button"
                  data-testid={`option-${option.index}`}
                  disabled={card.pending || disabled}
                  onClick={() => onChoose(card.questionId, option.index)}
                  className={optionClasses(option.style, card.pending || disabled)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
