// Inline-viewer eligibility (md-bui-style "open file inline") for a non-image
// attachment row. Deliberately extension-first, not mime-first: a browser
// upload's reported Content-Type for an uncommon source extension (.ts,
// .py, .go, …) is frequently empty or generic, and the SERVER'S sanitized
// mime (web.ts sanitizeUploadMime) then falls back to octet-stream for
// anything not on its small allow-list — neither is a reliable signal for
// "is this readable text", so this is the client's own, independent guess,
// based only on the filename the row already has.

const CODE_EXTENSIONS = new Set([
  'ts',
  'tsx',
  'js',
  'jsx',
  'mjs',
  'cjs',
  'py',
  'go',
  'rs',
  'rb',
  'java',
  'c',
  'h',
  'cpp',
  'cc',
  'hpp',
  'cs',
  'php',
  'swift',
  'kt',
  'kts',
  'sh',
  'bash',
  'zsh',
  'yaml',
  'yml',
  'json',
  'toml',
  'ini',
  'sql',
  'txt',
  'log',
  'csv',
  'xml',
  'html',
  'htm',
  'css',
  'scss',
  'env',
  'conf',
]);

export type InlineKind = 'markdown' | 'code' | 'none';

function extensionOf(name: string): string {
  const idx = name.lastIndexOf('.');
  if (idx <= 0 || idx === name.length - 1) return ''; // no ext, or a dotfile with nothing after the dot
  return name.slice(idx + 1).toLowerCase();
}

/** What kind of inline viewer (if any) a file row should offer, based on its name and reported mime. Images are handled entirely separately in AttachmentRow (already inline, untouched) and never reach this function. */
export function detectInlineKind(name: string, mime: string): InlineKind {
  const ext = extensionOf(name);
  if (ext === 'md' || ext === 'markdown') return 'markdown';
  if (mime.startsWith('text/') || mime === 'application/json' || CODE_EXTENSIONS.has(ext)) return 'code';
  return 'none';
}

/** Above this, a file only ever gets the download card — no inline offer, per the design brief. */
export const INLINE_MAX_BYTES = 1024 * 1024;
