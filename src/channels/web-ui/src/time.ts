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

/** "Today" / "Yesterday" / a full weekday+date label — for a date-separator row. */
export function formatDateSeparator(ts: number): string {
  const dayMs = 24 * 60 * 60 * 1000;
  const diff = Math.round((startOfLocalDay(Date.now()) - startOfLocalDay(ts)) / dayMs);
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Yesterday';
  return new Date(ts).toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
}
