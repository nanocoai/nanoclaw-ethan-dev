import { useState } from 'react';
import clsx from 'clsx';
import type { ChatFile } from '../types';
import { formatBytes } from '../format';
import { Timestamp } from './Timestamp';
import { detectInlineKind, INLINE_MAX_BYTES } from '../inline-view';
import { InlineFileViewer } from './InlineFileViewer';

/**
 * Appends the shared token the same way the WS connection does — a plain
 * `?token=` query param — or leaves the path untouched when this tab has no
 * token, which is the identity-auth case (WU4): the server authenticates the
 * download from the `Tailscale-User-Login` header instead, exactly as it did
 * for the WS upgrade that got us here.
 */
function withToken(downloadPath: string, token: string | null): string {
  if (!token) return downloadPath;
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
  const [expanded, setExpanded] = useState(false);
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

  const href = withToken(file.downloadPath, token);
  // New-tab links ask the server for an inline Content-Disposition; without
  // it every /files/ response says `attachment` and "open in new tab" can
  // only ever re-download (found live). The server still decides — unsafe
  // mimes (html/svg/xml) stay attachment regardless of this param. The
  // separator has to be computed rather than hardcoded to `&`: on the
  // identity-auth path there's no `?token=` ahead of it, so the query string
  // starts here.
  const inlineHref = `${href}${href.includes('?') ? '&' : '?'}inline=1`;
  const isImage = file.mime.startsWith('image/');
  // Inline "open file" (md-bui-style): markdown/code/text under ~1MB gets a
  // toggle to expand it inline; images are already inline (above) and never
  // reach here; PDFs and unknown binaries get no inline offer at all — same
  // download card (and an explicit "open in new tab") as before this feature.
  const inlineKind = detectInlineKind(file.name, file.mime);
  const canInline = inlineKind !== 'none' && file.size <= INLINE_MAX_BYTES;

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
          href={inlineHref}
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
  //
  // The inline-view toggle is a SEPARATE sibling button, not folded into
  // this one: `[data-testid="attachment-file"]` and its onClick (download)
  // are left byte-for-byte as they were before this feature, so the existing
  // golden proof (browser-proof-attachment.mjs, which clicks this exact
  // testid expecting a download) keeps working unchanged even for a file
  // that's now ALSO inline-eligible (e.g. the "send doc file" .txt fixture).
  return (
    <div
      className={clsx('nano-fade-in flex w-full flex-col px-4 py-2', isUser && 'items-end')}
      data-testid="attachment-row"
      data-role={file.role}
    >
      <div className="flex w-full max-w-[80%] items-center gap-2">
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
            'flex min-w-0 flex-1 items-center gap-3 rounded-2xl border px-4 py-3 text-left transition-colors',
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

        {canInline && (
          <button
            type="button"
            data-testid="attachment-view-toggle"
            aria-label={expanded ? 'collapse file preview' : 'view file inline'}
            onClick={() => setExpanded((e) => !e)}
            className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-3 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-900"
          >
            {expanded ? 'collapse' : 'view'}
          </button>
        )}

        {!canInline && (
          <a
            href={inlineHref}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="attachment-open-newtab"
            aria-label="open in a new tab"
            className="shrink-0 rounded-xl border border-zinc-800 bg-zinc-900/70 px-3 py-3 text-xs font-medium text-zinc-300 transition-colors hover:bg-zinc-900"
          >
            open ↗
          </a>
        )}
      </div>

      {expanded && canInline && (
        <InlineFileViewer downloadHref={href} kind={inlineKind} filename={file.name} onCollapse={() => setExpanded(false)} />
      )}

      <Timestamp ts={file.ts} className="mt-1" />
    </div>
  );
}
