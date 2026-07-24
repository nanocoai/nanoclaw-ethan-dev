import clsx from 'clsx';
import type { ConnectionStatus } from '../types';

const DOT: Record<ConnectionStatus, string> = {
  connecting: 'bg-amber-400',
  connected: 'bg-emerald-400',
  disconnected: 'bg-rose-500',
};

export function TopBar({ status, userId }: { status: ConnectionStatus; userId?: string | null }) {
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
        {/* Identity, only when the server actually reported one on the `ready`
            frame (WU4 Tailscale login). Plain text in the same muted
            treatment as the "web" label — nothing to click, no menu, no
            avatar: this is a statement of who the connection is, not an
            account UI. Truncates rather than pushing the status pill around
            on a narrow (phone) viewport. */}
        {userId && (
          <span
            className="max-w-[45vw] truncate text-xs text-zinc-500 sm:max-w-none"
            data-testid="user-identity"
            title={userId}
          >
            {userId}
          </span>
        )}
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
