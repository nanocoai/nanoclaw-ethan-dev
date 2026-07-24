/** Human-readable byte size (1024-based) — shared by attachment rows and the composer's pending-file chips. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '? B';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value >= 10 ? Math.round(value) : Math.round(value * 10) / 10} ${units[unitIndex]}`;
}
