import { forwardRef, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import clsx from 'clsx';
import { formatBytes } from '../format';

// Mirrors the server-side caps (web.ts MAX_FILE_BYTES / MAX_FILES_PER_MESSAGE)
// so the composer can reject an obviously-doomed attach/drop/paste locally,
// with an immediate message, instead of always waiting on a round trip to
// find out. The server re-checks unconditionally regardless — these are a
// UX nicety, never the authoritative gate.
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const MAX_FILES = 5;

export interface PromptInputHandle {
  /** Imperative escape hatch for drag-and-drop: App.tsx owns the drop zone (the whole conversation), this owns the pending-file state. */
  addFiles: (files: File[]) => void;
}

function validateAndMerge(existing: File[], incoming: File[]): { files: File[]; error: string | null } {
  let error: string | null = null;
  const accepted: File[] = [];
  for (const file of incoming) {
    if (file.size > MAX_FILE_BYTES) {
      error = `"${file.name}" is over the 25MB limit`;
      continue;
    }
    accepted.push(file);
  }
  let merged = [...existing, ...accepted];
  if (merged.length > MAX_FILES) {
    merged = merged.slice(0, MAX_FILES);
    error = `only the first ${MAX_FILES} files are attached (max ${MAX_FILES} per message)`;
  }
  return { files: merged, error };
}

export const PromptInput = forwardRef<
  PromptInputHandle,
  {
    disabled: boolean;
    onSend: (text: string, files: File[]) => void;
    uploadError: string | null;
    onDismissUploadError: () => void;
  }
>(function PromptInput({ disabled, onSend, uploadError, onDismissUploadError }, ref) {
  const [value, setValue] = useState('');
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [localError, setLocalError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = (incoming: File[]) => {
    if (incoming.length === 0) return;
    setPendingFiles((prev) => {
      const { files, error } = validateAndMerge(prev, incoming);
      setLocalError(error);
      return files;
    });
  };

  useImperativeHandle(ref, () => ({ addFiles }), []);

  // Grow the textarea with its content, up to a sensible cap.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 180)}px`;
  }, [value]);

  const submit = () => {
    const text = value.trim();
    if (disabled) return;
    if (!text && pendingFiles.length === 0) return;
    onSend(text, pendingFiles);
    setValue('');
    setPendingFiles([]);
    setLocalError(null);
    onDismissUploadError();
  };

  const canSend = (value.trim().length > 0 || pendingFiles.length > 0) && !disabled;
  const errorToShow = localError ?? uploadError;

  return (
    <div className="border-t border-zinc-800/80 bg-zinc-950/80 px-4 py-3 backdrop-blur">
      <div className="mx-auto w-full max-w-3xl">
        {pendingFiles.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5" data-testid="pending-files">
            {pendingFiles.map((file, index) => (
              <span
                key={`${file.name}-${index}`}
                data-testid="pending-chip"
                data-name={file.name}
                className="inline-flex max-w-[220px] items-center gap-1.5 rounded-full border border-zinc-700 bg-zinc-800/80 py-1 pl-3 pr-1.5 text-xs text-zinc-200"
              >
                <span className="truncate">{file.name}</span>
                <span className="shrink-0 text-zinc-500">{formatBytes(file.size)}</span>
                <button
                  type="button"
                  data-testid="remove-pending-chip"
                  aria-label={`remove ${file.name}`}
                  onClick={() => setPendingFiles((prev) => prev.filter((_, i) => i !== index))}
                  className="flex h-4 w-4 shrink-0 items-center justify-center rounded-full text-zinc-400 hover:bg-zinc-700 hover:text-zinc-100"
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        {errorToShow && (
          <div
            data-testid="upload-error"
            className="mb-2 flex items-center justify-between gap-2 rounded-lg border border-rose-500/40 bg-rose-500/10 px-3 py-1.5 text-xs text-rose-300"
          >
            <span>{errorToShow}</span>
            <button
              type="button"
              aria-label="dismiss error"
              onClick={() => {
                setLocalError(null);
                onDismissUploadError();
              }}
              className="shrink-0 text-rose-300/70 hover:text-rose-200"
            >
              ×
            </button>
          </div>
        )}

        <div
          className={clsx(
            'flex items-end gap-2 rounded-2xl border bg-zinc-900/70 px-3 py-2 transition-colors',
            'border-zinc-800 focus-within:border-zinc-600 focus-within:ring-1 focus-within:ring-zinc-600',
            disabled && 'opacity-60',
          )}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            hidden
            data-testid="file-input"
            onChange={(e) => {
              addFiles(Array.from(e.target.files ?? []));
              e.target.value = ''; // allow re-selecting the same file later
            }}
          />
          <button
            type="button"
            data-testid="attach-button"
            aria-label="attach file"
            disabled={disabled}
            onClick={() => fileInputRef.current?.click()}
            className="mb-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-zinc-400 transition-colors hover:bg-zinc-800 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <svg viewBox="0 0 20 20" className="h-4.5 w-4.5" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
              <path d="M13.5 6.5l-6 6a2.5 2.5 0 003.5 3.5l6-6a4.5 4.5 0 00-6.5-6.5l-6 6a6.5 6.5 0 009 9" />
            </svg>
          </button>

          <textarea
            ref={textareaRef}
            data-testid="composer-input"
            rows={1}
            value={value}
            disabled={disabled}
            placeholder={disabled ? 'disconnected' : 'message nanoclaw…'}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submit();
              }
            }}
            onPaste={(e) => {
              const items = e.clipboardData?.items;
              if (!items) return;
              const files: File[] = [];
              for (const item of items) {
                if (item.kind === 'file') {
                  const file = item.getAsFile();
                  if (file) files.push(file);
                }
              }
              // Only intercept the paste when it actually carried a file —
              // a normal text paste must keep working untouched.
              if (files.length > 0) {
                e.preventDefault();
                addFiles(files);
              }
            }}
            className="max-h-[180px] flex-1 resize-none bg-transparent py-1.5 text-[15px] leading-relaxed text-zinc-100 placeholder:text-zinc-600 focus:outline-none disabled:cursor-not-allowed"
          />
          <button
            type="button"
            data-testid="send-button"
            aria-label="send"
            disabled={!canSend}
            onClick={submit}
            className={clsx(
              'mb-0.5 inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-xl transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950',
              canSend
                ? 'bg-indigo-500 text-white hover:bg-indigo-400'
                : 'cursor-not-allowed bg-zinc-800 text-zinc-600',
            )}
          >
            <svg
              viewBox="0 0 20 20"
              className="h-4 w-4"
              fill="none"
              stroke="currentColor"
              strokeWidth={2}
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M10 16V4M10 4l-5 5M10 4l5 5" />
            </svg>
          </button>
        </div>
        <p className="mt-1.5 px-1 text-[11px] text-zinc-600">
          enter to send · shift + enter for a new line · drag files in or paste an image to attach
        </p>
      </div>
    </div>
  );
});
