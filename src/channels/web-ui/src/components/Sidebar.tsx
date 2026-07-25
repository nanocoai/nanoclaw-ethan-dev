import { useEffect, useState } from 'react';
import clsx from 'clsx';
import type { SessionSummary } from '../types';
import { formatRelativeTime } from '../time';

/**
 * Conversation sidebar (WU3), openwebui-style: one row per session, most
 * recently active first (the server sorts, this list renders that order),
 * "New chat" on top, an unread dot for a conversation that moved while you
 * were looking elsewhere, and a kebab -> confirm delete.
 *
 * ONE instance in the DOM, not one per breakpoint: it is a fixed off-canvas
 * drawer under `md` and a static column above it, switched with classes
 * rather than by rendering the list twice. Two copies would duplicate every
 * row's controls, which is both a11y noise and an ambiguous target for any
 * proof (or user) that asks for "the delete button".
 */
export function Sidebar({
  sessions,
  activeSessionId,
  unreadSessionIds,
  userId,
  open,
  onClose,
  onNew,
  onSwitch,
  onDelete,
}: {
  sessions: SessionSummary[];
  activeSessionId: string | null;
  unreadSessionIds: string[];
  userId: string | null;
  /** Mobile drawer state; ignored at `md` and up, where the sidebar is always in the layout. */
  open: boolean;
  onClose: () => void;
  onNew: () => void;
  onSwitch: (id: string) => void;
  onDelete: (id: string) => void;
}) {
  // Which row's kebab menu is open, and which row is asking to confirm a
  // delete. Both are single-valued: at most one menu and one confirmation can
  // be live at a time, so a stray click elsewhere always resolves to "close".
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [confirmFor, setConfirmFor] = useState<string | null>(null);

  // A session that disappeared (deleted from another tab, or by this one)
  // must not leave a menu/confirmation floating over nothing.
  useEffect(() => {
    const ids = new Set(sessions.map((session) => session.id));
    if (menuFor && !ids.has(menuFor)) setMenuFor(null);
    if (confirmFor && !ids.has(confirmFor)) setConfirmFor(null);
  }, [sessions, menuFor, confirmFor]);

  const unread = new Set(unreadSessionIds);

  return (
    <>
      {/* Scrim, mobile only: tapping outside the drawer closes it. Rendered
          only while open so it never swallows clicks on the desktop layout. */}
      {open && (
        <div
          className="fixed inset-0 z-30 bg-black/60 md:hidden"
          onClick={onClose}
          data-testid="sidebar-scrim"
          aria-hidden="true"
        />
      )}

      <aside
        className={clsx(
          'fixed inset-y-0 left-0 z-40 flex w-72 shrink-0 flex-col border-r border-zinc-800/80 bg-zinc-950 transition-transform duration-200',
          'md:static md:z-auto md:w-64 md:translate-x-0',
          open ? 'translate-x-0' : '-translate-x-full',
        )}
        data-testid="sidebar"
        data-open={open ? 'true' : 'false'}
      >
        <div className="flex h-14 shrink-0 items-center justify-between border-b border-zinc-800/80 px-3">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">chats</span>
          <button
            type="button"
            onClick={onNew}
            className="rounded-md border border-zinc-800 bg-zinc-900 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:border-zinc-700 hover:text-zinc-100"
            data-testid="new-session"
          >
            New chat
          </button>
        </div>

        <div className="scroll-area flex-1 overflow-y-auto px-2 py-2">
          {sessions.length === 0 ? (
            <p className="px-2 py-3 text-xs text-zinc-600" data-testid="sidebar-empty">
              no conversations yet
            </p>
          ) : (
            <ul className="flex flex-col gap-0.5">
              {sessions.map((session) => {
                const active = session.id === activeSessionId;
                return (
                  <li key={session.id} className="relative" data-testid="session-row" data-session-id={session.id}>
                    <div
                      className={clsx(
                        'group flex items-center gap-2 rounded-md px-2 py-2 transition-colors',
                        active ? 'bg-zinc-900 text-zinc-100' : 'text-zinc-400 hover:bg-zinc-900/60',
                      )}
                      data-active={active ? 'true' : 'false'}
                    >
                      <button
                        type="button"
                        onClick={() => {
                          onSwitch(session.id);
                          onClose();
                        }}
                        className="flex min-w-0 flex-1 items-center gap-2 text-left"
                        data-testid="session-open"
                      >
                        {/* Unread dot: something landed here while you were
                            reading another conversation. Never shown on the
                            active row — you are, by definition, current. The
                            slot is always present so titles stay aligned
                            whether or not a row is dotted. */}
                        <span className="flex h-1.5 w-1.5 shrink-0 items-center justify-center">
                          {unread.has(session.id) && !active && (
                            <span className="h-1.5 w-1.5 rounded-full bg-indigo-400" data-testid="session-unread" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-sm" data-testid="session-title">
                          {session.title || 'New chat'}
                        </span>
                        <span className="shrink-0 text-[10px] tabular-nums text-zinc-600" data-testid="session-time">
                          {formatRelativeTime(session.lastActiveAt)}
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setConfirmFor(null);
                          setMenuFor((current) => (current === session.id ? null : session.id));
                        }}
                        className="shrink-0 rounded px-1 text-zinc-600 transition-colors hover:text-zinc-300"
                        aria-label="conversation actions"
                        data-testid="session-kebab"
                      >
                        <span className="text-base leading-none">⋮</span>
                      </button>
                    </div>

                    {menuFor === session.id && confirmFor !== session.id && (
                      <div
                        className="absolute right-2 top-10 z-10 rounded-md border border-zinc-800 bg-zinc-900 py-1 shadow-lg"
                        data-testid="session-menu"
                      >
                        <button
                          type="button"
                          onClick={() => setConfirmFor(session.id)}
                          className="block w-full px-3 py-1.5 text-left text-xs text-rose-300 hover:bg-zinc-800"
                          data-testid="session-delete"
                        >
                          Delete
                        </button>
                      </div>
                    )}

                    {/* Confirm inline rather than in a modal: the row being
                        destroyed stays visible next to the question. */}
                    {confirmFor === session.id && (
                      <div
                        className="mt-1 rounded-md border border-zinc-800 bg-zinc-900 px-2 py-2"
                        data-testid="session-delete-confirm"
                      >
                        <p className="mb-2 text-[11px] text-zinc-400">Delete this conversation?</p>
                        <div className="flex gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmFor(null);
                              setMenuFor(null);
                              onDelete(session.id);
                            }}
                            className="rounded border border-rose-900/70 bg-rose-950/40 px-2 py-1 text-[11px] text-rose-200 hover:bg-rose-950/70"
                            data-testid="session-delete-yes"
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setConfirmFor(null);
                              setMenuFor(null);
                            }}
                            className="rounded border border-zinc-800 px-2 py-1 text-[11px] text-zinc-400 hover:text-zinc-200"
                            data-testid="session-delete-no"
                          >
                            Cancel
                          </button>
                        </div>
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        {/* WU4 identity, when the server reported one. Same muted treatment as
            the top bar's copy: a statement of who this connection is, not an
            account menu. */}
        {userId && (
          <div className="shrink-0 border-t border-zinc-800/80 px-3 py-2.5">
            <p className="truncate text-xs text-zinc-500" title={userId} data-testid="sidebar-user-identity">
              {userId}
            </p>
          </div>
        )}
      </aside>
    </>
  );
}
