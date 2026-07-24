import { useEffect, useState } from 'react';
import type { InlineKind } from '../inline-view';
import { Markdown } from './Markdown';

type LoadState = { status: 'loading' } | { status: 'ready'; text: string } | { status: 'error' };

/**
 * Inline "open file" panel (md-bui-style) below a non-image file row.
 * Fetches the file's bytes over the SAME authed /files/<id> URL the download
 * card already uses — no separate endpoint, so this works identically for a
 * live-arrived row and a replayed one (the URL doesn't care how the row got
 * there). Markdown renders through the SAME Markdown component assistant
 * messages use; code/text gets a monospace `<pre>` with a line-number
 * gutter and the filename as a header.
 */
export function InlineFileViewer({
  downloadHref,
  kind,
  filename,
  onCollapse,
}: {
  downloadHref: string;
  kind: InlineKind;
  filename: string;
  onCollapse: () => void;
}) {
  const [state, setState] = useState<LoadState>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    setState({ status: 'loading' });
    fetch(downloadHref)
      .then((res) => {
        if (!res.ok) throw new Error(`status ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (!cancelled) setState({ status: 'ready', text });
      })
      .catch(() => {
        if (!cancelled) setState({ status: 'error' });
      });
    return () => {
      cancelled = true;
    };
    // Re-fetch if the row's identity (its authed URL) actually changes —
    // never on `kind`/`filename` alone, which don't affect what bytes to load.
  }, [downloadHref]);

  return (
    <div
      className="nano-fade-in mt-2 w-full max-w-[80%] overflow-hidden rounded-2xl border border-zinc-800 bg-[#0d0d10]"
      data-testid="inline-viewer"
    >
      <div
        className="flex items-center justify-between gap-2 border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5"
        data-testid="inline-viewer-header"
      >
        <span className="truncate font-mono text-[11px] text-zinc-400">{filename}</span>
        <button
          type="button"
          onClick={onCollapse}
          className="shrink-0 text-[11px] font-medium text-indigo-400 hover:text-indigo-300"
        >
          collapse
        </button>
      </div>

      {state.status === 'loading' && (
        <div className="px-3 py-3 text-xs text-zinc-500" data-testid="inline-viewer-loading">
          loading…
        </div>
      )}

      {state.status === 'error' && (
        <div className="px-3 py-3 text-xs text-zinc-500" data-testid="inline-viewer-error">
          could not load this file for preview
        </div>
      )}

      {state.status === 'ready' && kind === 'markdown' && (
        <div className="max-h-96 overflow-y-auto px-3 py-3" data-testid="inline-viewer-markdown">
          <Markdown content={state.text} />
        </div>
      )}

      {state.status === 'ready' && kind === 'code' && (
        <div className="max-h-96 overflow-auto" data-testid="inline-viewer-code">
          <table className="w-full border-collapse font-mono text-[12.5px] leading-relaxed">
            <tbody>
              {state.text.split('\n').map((line, i) => (
                <tr key={i} data-testid="inline-viewer-code-line">
                  <td className="select-none whitespace-nowrap px-3 py-0 text-right text-zinc-600" data-testid="inline-viewer-line-number">
                    {i + 1}
                  </td>
                  <td className="w-full whitespace-pre px-3 py-0 text-zinc-200">{line.length > 0 ? line : ' '}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
