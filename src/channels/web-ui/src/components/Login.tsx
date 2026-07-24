import { useState } from 'react';
import clsx from 'clsx';

export function Login({
  authError,
  onSubmit,
}: {
  authError: boolean;
  onSubmit: (token: string) => void;
}) {
  const [value, setValue] = useState('');
  const canSubmit = value.trim().length > 0;

  const submit = () => {
    if (!canSubmit) return;
    onSubmit(value);
  };

  return (
    <div className="flex min-h-full flex-1 items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          <div className="flex h-11 w-11 items-center justify-center rounded-xl border border-zinc-800 bg-zinc-900 text-indigo-400">
            <span className="h-2.5 w-2.5 rounded-full bg-indigo-400" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-zinc-100">nanoclaw</h1>
            <p className="mt-1 text-sm text-zinc-500">
              enter your access token to connect
            </p>
          </div>
        </div>

        <div className="rounded-2xl border border-zinc-800 bg-zinc-900/60 p-4">
          <label
            htmlFor="login-token"
            className="mb-1.5 block text-xs text-zinc-500"
          >
            access token
          </label>
          <input
            id="login-token"
            data-testid="login-input"
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            placeholder="token"
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
            }}
            className="w-full rounded-xl border border-zinc-800 bg-zinc-950 px-3 py-2.5 text-sm text-zinc-100 placeholder:text-zinc-600 focus:border-zinc-600 focus:outline-none focus:ring-1 focus:ring-zinc-600"
          />

          {authError && (
            <p className="mt-2.5 flex items-center gap-1.5 text-xs text-rose-400">
              <span className="h-1.5 w-1.5 rounded-full bg-rose-500" />
              invalid token — check it and try again
            </p>
          )}

          <button
            type="button"
            data-testid="login-submit"
            disabled={!canSubmit}
            onClick={submit}
            className={clsx(
              'mt-3.5 inline-flex w-full items-center justify-center rounded-xl px-3 py-2.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 focus-visible:ring-offset-2 focus-visible:ring-offset-zinc-950',
              canSubmit
                ? 'bg-indigo-500 text-white hover:bg-indigo-400'
                : 'cursor-not-allowed bg-zinc-800 text-zinc-600',
            )}
          >
            connect
          </button>
        </div>
      </div>
    </div>
  );
}
