/** Centered pill marking a day boundary in the conversation (local calendar day). */
export function DateSeparator({ label }: { label: string }) {
  return (
    <div className="my-1 flex w-full items-center justify-center px-4 py-2" data-testid="date-separator">
      <span className="rounded-full border border-zinc-800 bg-zinc-900/60 px-3 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
        {label}
      </span>
    </div>
  );
}
