/**
 * P2b stale-bundle banner. Shown once this tab has already spent its one
 * automatic reload attempt on a mismatched server `bundle` and is STILL
 * mismatched (useNanoclaw.ts bundleStale) — i.e. reloading again on its own
 * would risk looping, so this hands the decision to a human instead.
 *
 * Deliberately non-dismissible (no close button): the tab really is running
 * code the server no longer expects, and the whole point of P2b is that a
 * silent gap here is what caused the original incident (duplicate bubbles,
 * a `file` frame nobody saw). A banner that could be dismissed and forgotten
 * would just recreate the bug it's fixing.
 */
export function UpdateBanner({ onReload }: { onReload: () => void }) {
  return (
    <div
      data-testid="bundle-update-banner"
      className="flex shrink-0 items-center justify-between gap-3 border-b border-amber-500/30 bg-amber-500/10 px-4 py-2"
    >
      <span className="flex items-center gap-2 text-xs text-amber-200">
        <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-400" />
        web app updated — reload to catch up
      </span>
      <button
        type="button"
        data-testid="bundle-update-reload"
        onClick={onReload}
        className="shrink-0 rounded-full border border-amber-400/40 bg-amber-500/10 px-2.5 py-1 text-xs font-medium text-amber-100 transition-colors hover:bg-amber-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950"
      >
        reload
      </button>
    </div>
  );
}
