import { memo } from 'react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeHighlight from 'rehype-highlight';

/** Detects a fenced block: rehype-highlight stamps `hljs` onto block code only. */
function isBlockCode(className: string | undefined): boolean {
  return /(^|\s)(hljs|language-)/.test(className ?? '');
}

function languageOf(className: string | undefined): string {
  const match = /language-([\w-]+)/.exec(className ?? '');
  return match?.[1] ?? 'text';
}

const components: Components = {
  // Unwrap the default <pre>; the `code` renderer supplies the block shell.
  pre: ({ children }) => <>{children}</>,
  code: ({ className, children, ...props }) => {
    if (!isBlockCode(className)) {
      // Inline code — styled as a subtle pill via .md code css.
      return (
        <code className={className} {...props}>
          {children}
        </code>
      );
    }
    return (
      <div className="my-3 overflow-hidden rounded-xl border border-zinc-800 bg-[#0d0d10]">
        <div className="flex items-center justify-between border-b border-zinc-800 bg-zinc-900/60 px-3 py-1.5">
          <span className="font-mono text-[11px] lowercase tracking-wide text-zinc-500">
            {languageOf(className)}
          </span>
        </div>
        <pre>
          <code className={className ?? 'hljs'} {...props}>
            {children}
          </code>
        </pre>
      </div>
    );
  },
};

export const Markdown = memo(function Markdown({
  content,
}: {
  content: string;
}) {
  return (
    <div className="md text-[15px] leading-relaxed text-zinc-100" data-testid="assistant-markdown">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { detect: true, ignoreMissing: true }]]}
        components={components}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
});
