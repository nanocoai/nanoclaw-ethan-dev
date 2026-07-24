import { formatClockTime } from '../time';

/**
 * Small muted HH:MM shown on every message/card/file row. Renders nothing
 * when `ts` is absent — the backward-compat contract for a frame that
 * predates timestamp support (see web.ts emit()): "missing ts" means "don't
 * show a time", never "show a fallback/blank time".
 */
export function Timestamp({ ts, className = '' }: { ts: number | undefined; className?: string }) {
  if (ts === undefined) return null;
  return (
    <span className={`shrink-0 text-[10px] tabular-nums text-zinc-600 ${className}`} data-testid="item-timestamp">
      {formatClockTime(ts)}
    </span>
  );
}
