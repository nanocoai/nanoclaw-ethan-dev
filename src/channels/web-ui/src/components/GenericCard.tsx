import clsx from 'clsx';
import type { ChatGenericCard, OptionStyle } from '../types';
import { Timestamp } from './Timestamp';

function linkClasses(style: OptionStyle | undefined) {
  const base =
    'inline-flex items-center justify-center rounded-lg px-3.5 py-2 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950';
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

/**
 * Generic display card (send_card MCP tool) — title, body paragraphs, and
 * link-style actions. No callback buttons: links just open the URL, matching
 * the Chat SDK bridge's fire-and-forget send_card semantics.
 */
export function GenericCard({ card }: { card: ChatGenericCard }) {
  return (
    <div className="nano-fade-in flex w-full px-4 py-2">
      <div
        className="w-full max-w-[80%] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/70 shadow-[0_1px_0_0_rgba(255,255,255,0.02)_inset]"
        data-testid="generic-card"
      >
        {(card.title || card.ts !== undefined) && (
          <div className="flex items-center justify-between gap-2 border-b border-zinc-800/80 bg-zinc-900/40 px-4 py-2.5">
            <span
              className="text-[11px] font-semibold uppercase tracking-widest text-zinc-500"
              data-testid="generic-card-title"
            >
              {card.title}
            </span>
            <Timestamp ts={card.ts} />
          </div>
        )}

        {(card.body.length > 0 || card.links.length > 0) && (
          <div className="px-4 py-4">
            {card.body.map((paragraph, index) => (
              <p
                key={index}
                className={clsx('text-[15px] leading-relaxed text-zinc-100', index > 0 && 'mt-2')}
                data-testid="generic-card-body"
              >
                {paragraph}
              </p>
            ))}

            {card.links.length > 0 && (
              <div className={clsx('flex flex-wrap gap-2', card.body.length > 0 && 'mt-4')}>
                {card.links.map((link, index) => (
                  <a
                    key={index}
                    href={link.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    data-testid={`generic-card-link-${index}`}
                    className={linkClasses(link.style)}
                  >
                    {link.label}
                  </a>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
