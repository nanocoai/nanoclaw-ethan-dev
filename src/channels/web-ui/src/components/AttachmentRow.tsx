import { useState } from 'react';
import clsx from 'clsx';
import type { ChatFile } from '../types';
import { formatBytes } from '../format';
import { Timestamp } from './Timestamp';

/** Appends the shared token the same way the WS connection does — a plain `?token=` query param. */
function withToken(downloadPath: string, token: string): string {
  const sep = downloadPath.includes('?') ? '&' : '?';
  return `${downloadPath}${sep}token=${encodeURIComponent(token)}`;
}

/**
 * One file attachment — outbound (the agent sent it, P2a) or inbound (the
 * user uploaded it, files-IN), distinguished by `file.role`. image/* mime
 * gets an inline, click-to-open thumbnail; everything else gets a download
 * card. Either shape can end up "no longer available" if the file was
 * evicted from the server's bounded in-memory map (or the process
 * restarted) after the frame was recorded — the download link still LOOKS
 * fine in a replayed history until it's actually used, so failure is only
 * detectable at fetch/load time, not render time.
 */
export function AttachmentRow({ file, token }: { file: ChatFile; token: string | null }) {
  const [unavailable, setUnavailable] = useState(false);
  const isUser = file.role === 'user';

  // Malformed/unknown file frame (missing the fields we need to render or
  // download) — never render nothing, show a visible placeholder instead.
  if (!file.name || !file.downloadPath) {
    return (
      <div className={clsx('nano-fade-in flex w-full px-4 py-2', isUser && 'justify-end')}>
        <div
          className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/70 px-4 py-2.5 text-sm text-zinc-400"
          data-testid="attachment-placeholder"
        >
          attachment could not be displayed
        </div>
      </div>
    );
  }

  if (!token) return null; // no session token yet — nothing to authenticate a download with
  const href = withToken(file.downloadPath, token);
  const isImage = file.mime.startsWith('image/');

  if (unavailable) {
    return (
      <div className={clsx('nano-fade-in flex w-full px-4 py-2', isUser && 'justify-end')}>
        <div
          className="flex items-center gap-2 rounded-xl border border-zinc-800 bg-zinc-900/50 px-4 py-2.5 text-sm text-zinc-500"
          data-testid="attachment-unavailable"
        >
          <span className="truncate">{file.name}</span>
          <span className="text-zinc-600">— no longer available</span>
        </div>
      </div>
    );
  }

  if (isImage) {
    return (
      <div
        className={clsx('nano-fade-in flex w-full flex-col px-4 py-2', isUser && 'items-end')}
        data-testid="attachment-row"
        data-role={file.role}
      >
        <a
          href={href}
          target="_blank"
          rel="noopener noreferrer"
          data-testid="attachment-image"
          data-name={file.name}
          // `w-full` (not just `max-w-[60%]`) is load-bearing: as a flex
          // item this anchor otherwise has no definite width to resolve
          // against, so the img's own `w-full` below has nothing to be
          // 100% OF — a circular auto/auto sizing that collapses the whole
          // thumbnail down to the image's raw intrinsic pixel size instead
          // of filling the row (visible immediately with a small image).
          className="block w-full max-w-[60%] overflow-hidden rounded-2xl border border-zinc-800 bg-zinc-900/70"
        >
          <img
            src={href}
            alt={file.name}
            className="block max-h-80 w-full object-contain"
            onError={() => setUnavailable(true)}
          />
        </a>
        <Timestamp ts={file.ts} className="mt-1" />
      </div>
    );
  }

  // Download card: filename, human size, explicit download action. Fetches
  // itself (rather than a bare `<a href download>`) so a failed download —
  // an evicted or post-restart file — surfaces as the "no longer available"
  // state above instead of a silent browser-level failure. `isUser` swaps
  // the border/background for the same treatment Message.tsx gives a user
  // text bubble, so an uploaded file reads as "the same side" as the user's
  // own messages.
  return (
    <div
      className={clsx('nano-fade-in flex w-full flex-col px-4 py-2', isUser && 'items-end')}
      data-testid="attachment-row"
      data-role={file.role}
    >
      <button
        type="button"
        data-testid="attachment-file"
        data-name={file.name}
        onClick={async () => {
          try {
            const res = await fetch(href);
            if (!res.ok) {
              setUnavailable(true);
              return;
            }
            const blob = await res.blob();
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            a.download = file.name;
            a.click();
            URL.revokeObjectURL(blobUrl);
          } catch {
            setUnavailable(true);
          }
        }}
        className={clsx(
          'flex w-full max-w-[80%] items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors',
          isUser
            ? 'border-zinc-700/60 bg-zinc-800/70 hover:bg-zinc-800'
            : 'border-zinc-800 bg-zinc-900/70 hover:bg-zinc-900',
        )}
      >
        <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-zinc-700 bg-zinc-800 text-zinc-400">
          <svg viewBox="0 0 20 20" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
            <path d="M6 2.5h5.5L15 6v11.5H6z" />
            <path d="M11.5 2.5V6H15" />
          </svg>
        </div>
        <div className="min-w-0 flex-1">
          <div className="truncate text-[15px] text-zinc-100" data-testid="attachment-file-name">
            {file.name}
          </div>
          <div className="text-xs text-zinc-500" data-testid="attachment-file-size">
            {formatBytes(file.size)}
          </div>
        </div>
        <span className="shrink-0 text-xs font-medium text-indigo-400">download</span>
      </button>
      <Timestamp ts={file.ts} className="mt-1" />
    </div>
  );
}
