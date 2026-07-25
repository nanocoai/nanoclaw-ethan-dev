// Message-timestamp formatting — browser local time throughout, no timezone
// gymnastics (no UTC conversion, no server-side tz lookup): `ts` is an epoch-ms
// number stamped server-side (web.ts emit()), and every formatter here just
// hands it to the browser's own Date/Intl machinery, which already knows the
// viewer's local offset.

/** Small muted "HH:MM" (24h) shown on a message/card/file row. */
export function formatClockTime(ts: number): string {
  return new Date(ts).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', hour12: false });
}

function startOfLocalDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

/** True if `a` and `b` fall on the same calendar day in the viewer's local time. */
export function isSameLocalDay(a: number, b: number): boolean {
  return startOfLocalDay(a) === startOfLocalDay(b);
}

/**
 * Compact "how long ago" for a sidebar row: "now", "5m", "3h", "2d", then a
 * plain date once a week has passed. Deliberately terse — the sidebar has one
 * short line per conversation, and a full "2 hours ago" would crowd out the
 * title, which is the thing the operator is actually scanning for.
 */
export function formatRelativeTime(ts: number, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - ts) / 1000));
  if (seconds < 60) return 'now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "Today" / "Yesterday" / a full weekday+date label — for a date-separator row. */
export function formatDateSeparator(ts: number): string {
  const dayMs = 24 * 60 * 60 * 1000;
  const diff = Math.round((startOfLocalDay(Date.now()) - startOfLocalDay(ts)) / dayMs);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
