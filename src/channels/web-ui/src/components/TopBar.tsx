import clsx from 'clsx';
import type { ConnectionStatus } from '../types';

const DOT: Record<ConnectionStatus, string> = {
  connecting: 'bg-amber-400',
  connected: 'bg-emerald-400',
  disconnected: 'bg-rose-500',
};

export function TopBar({ status }: { status: ConnectionStatus }) {
  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800/80 bg-zinc-950/80 px-4 backdrop-blur">
      <div className="flex items-center gap-2.5">
        <div className="flex h-6 w-6 items-center justify-center rounded-md border border-zinc-800 bg-zinc-900">
          <span className="h-2 w-2 rounded-full bg-indigo-400" />
        </div>
        <span className="text-sm font-semibold tracking-tight text-zinc-100">
          nanoclaw
        </span>
        <span className="text-xs text-zinc-600">web</span>
      </div>

      <div
        className="flex items-center gap-2 rounded-full border border-zinc-800 bg-zinc-900/60 px-2.5 py-1"
        data-testid="connection-status"
      >
        <span
          className={clsx(
            'h-2 w-2 rounded-full',
            DOT[status],
            status === 'connecting' && 'nano-dot',
          )}
        />
        <span className="text-xs text-zinc-400">{status}</span>
      </div>
    </header>
  );
}
