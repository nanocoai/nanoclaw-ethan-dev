/**
 * Standalone harness for the web channel adapter.
 *
 * Instantiates createWebAdapter() with a FAKE ChannelSetup that records every
 * onInbound / onAction / onMetadata call (to stdout AND a JSONL event log),
 * then plays the host's role: when a browser sends a user message, it replies
 * with a rich markdown message and an `ask_question` approval card whose
 * content shape is copied verbatim from src/modules/approvals/primitive.ts.
 * A real browser (Playwright) then clicks a button; the resulting onAction
 * call is what proves the round-trip.
 *
 * Threads/sessions (WU3): every reply goes back out on the SAME `threadId`
 * the inbound arrived on, which is what the real host does — it keys agent
 * sessions on (messaging_group_id, thread_id) and replies into the
 * originating thread. That is what lets a proof drive several conversations
 * at once and assert each answer landed in the one that asked. The
 * `echo <text>` scenario exists for exactly that: a reply whose text says
 * which turn produced it.
 *
 * Run:  NANOCLAW_WEB_TOKEN=<tok> tsx scripts/web-channel-harness.ts [eventLogPath]
 *
 * Env:
 *   NANOCLAW_WEB_TOKEN          shared token the browser must present (required here)
 *   NANOCLAW_WEB_PORT           listen port (default 7890)
 *   WEB_HARNESS_DATADIR         scratch data dir (default ./.harness-data)
 *   NANOCLAW_WEB_BUNDLE_OVERRIDE  P2b test knob: forces the `bundle` value the
 *     adapter reports in its `ready` frame instead of computing it from the
 *     real served dist/index.html. The literal value `__omit__` forces the
 *     field to be omitted entirely (simulates a pre-P2b server for
 *     backward-compat proofs). Unset (the default) uses the real computation
 *     — see scripts/browser-proof-bundle-mismatch.mjs for how this is used.
 */
import fs from 'fs';
import path from 'path';

import { createWebAdapter, type WebChannelOptions } from '../src/channels/web.js';
import type { ChannelSetup, InboundMessage, OutboundFile } from '../src/channels/adapter.js';
import { type RawOption } from '../src/channels/ask-question.js';

// ── Copied verbatim from src/modules/approvals/primitive.ts (APPROVAL_OPTIONS,
//    REJECT_WITH_REASON_VALUE) so the card is byte-identical to what core ships.
const REJECT_WITH_REASON_VALUE = 'reject_with_reason';
const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
  { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: REJECT_WITH_REASON_VALUE },
];

// P2a attachment proof fixtures. A real (tiny, valid) 1x1 transparent PNG —
// so browser-proof-attachment.mjs can drive an actual <img> load, not just a
// content-type label — and a plain text "document" for the non-image
// download-card path.
const DEMO_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
const DEMO_PNG = Buffer.from(DEMO_PNG_BASE64, 'base64');
const DEMO_DOC = Buffer.from('hello from the agent — this is a plain text attachment\n', 'utf8');

// Inline-viewer proof fixtures (commit 3). A markdown file (renders through
// the same Markdown component assistant messages use), a small code file
// (line-numbered monospace viewer), and a file deliberately just over the
// 1MB inline-eligibility cap (INLINE_MAX_BYTES, inline-view.ts) — proving
// the size gate, not just the extension/mime gate.
const DEMO_MARKDOWN = Buffer.from(
  ['# release notes', '', 'This is **markdown** rendered inline.', '', '- item one', '- item two'].join('\n') + '\n',
  'utf8',
);
const DEMO_CODE = Buffer.from(
  ['def greet(name):', '    print(f"hello, {name}")', '', 'greet("nanoclaw")', ''].join('\n'),
  'utf8',
);
const DEMO_BIG_FILE = Buffer.from('x'.repeat(1024 * 1024 + 1024), 'utf8'); // just over 1MB

const eventLogPath =
  process.argv[2] ?? path.join(process.cwd(), '.harness-data', 'events.jsonl');
fs.mkdirSync(path.dirname(eventLogPath), { recursive: true });
fs.writeFileSync(eventLogPath, ''); // truncate on start

function record(event: string, payload: Record<string, unknown>): void {
  const line = JSON.stringify({ ts: new Date().toISOString(), event, ...payload });
  console.log(`RECORD ${line}`);
  fs.appendFileSync(eventLogPath, line + '\n');
}

const PLATFORM_ID = 'local';

// The adapter is created before we can reference it in the closure, so hold a
// mutable handle.
let deliver!: (
  platformId: string,
  threadId: string | null,
  message: { kind: string; content: unknown; files?: OutboundFile[] },
) => Promise<string | undefined>;
let setTyping!: (platformId: string, threadId: string | null) => Promise<void>;

// Pending release for the 'ghost typing test' scenario (see onInbound below)
// — set while that scenario is awaiting its SIGUSR1, null otherwise.
let resolveGhostTypingRelease: (() => void) | null = null;

/** Text of an inbound `user_message` — used to pick which demo scenario to play. */
function inboundText(message: InboundMessage): string {
  const content = message.content as Record<string, unknown> | undefined;
  return typeof content?.text === 'string' ? content.text : '';
}

const setup: ChannelSetup = {
  async onInbound(platformId: string, threadId: string | null, message: InboundMessage) {
    record('onInbound', { platformId, threadId, message });

    const text = inboundText(message);

    // Multi-session scenario: reply with the same text back, on the same
    // thread. A proof driving two conversations at once can then assert that
    // "echo A" answered in conversation A and nowhere else — the whole point
    // of routing deliver() by threadId.
    if (text.startsWith('echo ')) {
      const payload = text.slice('echo '.length);
      await deliver(PLATFORM_ID, threadId, { kind: 'chat-sdk', content: { markdown: `echo: ${payload}` } });
      record('echoDelivered', { threadId, payload });
      return;
    }

    // Phase-1 parity scenarios (generic card rendering) — everything else
    // falls through to the original markdown + approval card demo below.
    if (text === 'show generic card') {
      await deliver(PLATFORM_ID, threadId, {
        kind: 'chat-sdk',
        content: {
          type: 'card',
          card: {
            title: 'Release notes',
            description: 'v2.1.53 shipped the web channel phase-1 parity work.',
            children: ['Generic cards, message edits, and reconnect + history all land in this build.'],
            actions: [
              { label: 'View changelog', url: 'https://nanoclaw.dev/changelog', style: 'primary' },
              { label: 'Open docs', url: 'https://docs.nanoclaw.dev' },
            ],
          },
          fallbackText: 'Release notes: v2.1.53 shipped the web channel phase-1 parity work.',
        },
      });
      record('genericCardDelivered', {});
      return;
    }

    if (text === 'show fallback card') {
      // No title/description/children/actions — only a fallbackText. Proves
      // the adapter never silently drops an unrenderable send_card payload.
      await deliver(PLATFORM_ID, threadId, {
        kind: 'chat-sdk',
        content: { type: 'card', card: {}, fallbackText: 'Fallback-only card: nothing structured to render.' },
      });
      record('fallbackCardDelivered', {});
      return;
    }

    if (text === 'edit test') {
      // Deliver a message, then edit it in place — mirrors an approval
      // expiring (onecli-approvals.ts editCardExpired: deliver() an
      // operation:'edit' against the messageId the earlier deliver() call
      // returned).
      const messageId = await deliver(PLATFORM_ID, threadId, {
        kind: 'chat-sdk',
        content: { markdown: 'Original message — about to be edited.' },
      });
      record('editTargetDelivered', { messageId });
      await new Promise((r) => setTimeout(r, 300));
      await deliver(PLATFORM_ID, threadId, {
        kind: 'chat-sdk',
        content: { operation: 'edit', messageId, text: 'Edited in place — the original text is gone.' },
      });
      record('editApplied', { messageId });
      return;
    }

    if (text === 'edit unknown') {
      // Edit targeting an id the adapter never delivered — the SPA must
      // append it rather than drop it.
      await deliver(PLATFORM_ID, threadId, {
        kind: 'chat-sdk',
        content: { operation: 'edit', messageId: 'never-delivered-id', text: 'Edit for an id nobody has seen.' },
      });
      record('editForUnknownIdApplied', {});
      return;
    }

    if (text === 'ghost typing test') {
      // Ghost-typing proof scaffold (scripts/browser-proof-typing-ghost.mjs).
      // Sets typing:true, then BLOCKS the turn on an external release instead
      // of a fixed delay — this is what lets the proof script deterministically
      // control when the server's typing:false actually fires, instead of
      // racing it against the SPA's own reconnect backoff. Send SIGUSR1 to
      // this process to release the hold; the turn then completes normally
      // (typing:false + a recorded markdown message).
      await setTyping(PLATFORM_ID, threadId);
      record('ghostTypingStarted', {});
      await new Promise<void>((resolve) => {
        resolveGhostTypingRelease = resolve;
      });
      record('ghostTypingReleased', {});
      await deliver(PLATFORM_ID, threadId, {
        kind: 'chat-sdk',
        content: { markdown: 'ghost typing test — turn completed after the release signal.' },
      });
      record('ghostTypingDelivered', {});
      return;
    }

    // P2a proof scenarios — outbound file attachments.
    if (text === 'send file') {
      // A single image attachment, no accompanying text — the exact "model
      // sent code as a file, user saw nothing" incident shape, minus the
      // silent drop.
      const messageId = await deliver(PLATFORM_ID, threadId, {
        kind: 'chat-sdk',
        content: {},
        files: [{ filename: 'demo.png', data: DEMO_PNG }],
      });
      record('fileDelivered', { messageId, filename: 'demo.png' });
      return;
    }

    if (text === 'send doc file') {
      // Non-image attachment — SPA renders a download card, not a thumbnail.
      const messageId = await deliver(PLATFORM_ID, threadId, {
        kind: 'chat-sdk',
        content: {},
        files: [{ filename: 'notes.txt', data: DEMO_DOC }],
      });
      record('fileDelivered', { messageId, filename: 'notes.txt' });
      return;
    }

    if (text === 'send markdown file') {
      const messageId = await deliver(PLATFORM_ID, threadId, {
        kind: 'chat-sdk',
        content: {},
        files: [{ filename: 'README.md', data: DEMO_MARKDOWN }],
      });
      record('fileDelivered', { messageId, filename: 'README.md' });
      return;
    }

    if (text === 'send code file') {
      const messageId = await deliver(PLATFORM_ID, threadId, {
        kind: 'chat-sdk',
        content: {},
        files: [{ filename: 'greet.py', data: DEMO_CODE }],
      });
      record('fileDelivered', { messageId, filename: 'greet.py' });
      return;
    }

    if (text === 'send big file') {
      // Just over INLINE_MAX_BYTES (1MB) — must render as a plain download
      // card with NO inline-view toggle at all, regardless of its .txt
      // extension (which would otherwise be inline-eligible).
      const messageId = await deliver(PLATFORM_ID, threadId, {
        kind: 'chat-sdk',
        content: {},
        files: [{ filename: 'huge-log.txt', data: DEMO_BIG_FILE }],
      });
      record('fileDelivered', { messageId, filename: 'huge-log.txt', size: DEMO_BIG_FILE.length });
      return;
    }

    if (text === 'send bad file') {
      // Zero-length data — registerFile() rejects it; never-drop must
      // surface a plain visible message instead of silently eating it.
      await deliver(PLATFORM_ID, threadId, {
        kind: 'chat-sdk',
        content: {},
        files: [{ filename: 'empty.bin', data: Buffer.alloc(0) }],
      });
      record('fileNeverDropApplied', {});
      return;
    }

    if (text === 'flood files') {
      // Deliver more files than FILE_COUNT_LIMIT (50, web.ts) back-to-back so
      // the oldest ones get evicted before the newest ones. A trailing plain
      // message marks the end so a proof script watching the WS knows when
      // to stop collecting `file` frames.
      const FLOOD_COUNT = 55;
      for (let i = 0; i < FLOOD_COUNT; i++) {
        await deliver(PLATFORM_ID, threadId, {
          kind: 'chat-sdk',
          content: {},
          files: [{ filename: `flood-${i}.bin`, data: Buffer.from(`flood file #${i}`) }],
        });
      }
      await deliver(PLATFORM_ID, threadId, { kind: 'chat-sdk', content: { markdown: 'flood done' } });
      record('floodFilesDelivered', { count: FLOOD_COUNT });
      return;
    }

    // Play host: acknowledge with a rich markdown message, then an approval card.
    // Delays are env-overridable (default 350/150ms) so a proof can stretch the
    // in-flight-turn window wide enough for a real browser page.reload() cycle
    // to land reliably mid-turn (see browser-proof-refresh-mid-turn.mjs).
    const typingDelayMs = Number(process.env.HARNESS_TYPING_DELAY_MS ?? 350);
    const cardDelayMs = Number(process.env.HARNESS_CARD_DELAY_MS ?? 150);
    await setTyping(PLATFORM_ID, threadId);
    await new Promise((r) => setTimeout(r, typingDelayMs));

    const markdown = [
      '### deploy summary',
      '',
      "Here's what I'm about to run. It touches **production**, so I'll ask before proceeding.",
      '',
      '- build the ARM64 image (`linux/arm64`)',
      '- push to the registry',
      '- roll the `web` service with zero downtime',
      '',
      '```bash',
      'docker buildx build --platform linux/arm64 -t nanoclaw/web:latest .',
      'docker push nanoclaw/web:latest',
      '```',
      '',
      'Sound good?',
    ].join('\n');
    await deliver(PLATFORM_ID, threadId, { kind: 'chat-sdk', content: { markdown } });

    await new Promise((r) => setTimeout(r, cardDelayMs));

    // The exact payload core delivers (primitive.ts requestApproval()).
    const questionId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await deliver(PLATFORM_ID, threadId, {
      kind: 'chat-sdk',
      content: {
        type: 'ask_question',
        questionId,
        title: 'Approval required',
        question: 'Deploy nanoclaw/web:latest to production?',
        options: APPROVAL_OPTIONS,
      },
    });
    record('cardDelivered', { questionId });
  },

  onInboundEvent(event) {
    record('onInboundEvent', { event });
  },

  onMetadata(platformId: string, name?: string, isGroup?: boolean) {
    record('onMetadata', { platformId, name, isGroup });
  },

  onAction(questionId: string, selectedOption: string, userId: string) {
    // THE proof: a browser button click surfaces here with the resolved value.
    record('onAction', { questionId, selectedOption, userId });
  },
};

async function main() {
  const token = process.env.NANOCLAW_WEB_TOKEN;
  if (!token) {
    console.error('Set NANOCLAW_WEB_TOKEN before running the harness.');
    process.exit(1);
  }
  const dataDir = process.env.WEB_HARNESS_DATADIR ?? path.join(process.cwd(), '.harness-data');

  // P2b test knob (see the file header): only set the `bundleOverride` key at
  // all when the env var is present — createWebAdapter distinguishes "key
  // absent" (use the real computed fingerprint) from "key present as null"
  // (omit the field entirely), so this must not pass `bundleOverride:
  // undefined` unconditionally.
  const rawBundleOverride = process.env.NANOCLAW_WEB_BUNDLE_OVERRIDE;
  const adapterOptions: WebChannelOptions = { dataDir };
  if (rawBundleOverride !== undefined) {
    adapterOptions.bundleOverride = rawBundleOverride === '__omit__' ? null : rawBundleOverride;
  }
  const adapter = createWebAdapter(adapterOptions);
  deliver = adapter.deliver.bind(adapter);
  setTyping = adapter.setTyping!.bind(adapter);

  await adapter.setup(setup);
  console.log(`HARNESS READY  event log: ${eventLogPath}`);
  fs.writeFileSync(path.join(dataDir, 'harness.pid'), String(process.pid));

  // Phase-1 parity: prove the reconnect + history-replay path survives the
  // WS server itself bouncing, not just a dropped client socket. SIGUSR2
  // tears down and re-sets-up the SAME adapter instance — the http/ws layer
  // gets rebuilt, but renderStore / deliveredMessageIds / history all live in
  // createWebAdapter()'s outer closure, so they ride through untouched. This
  // is the "kill/restart the WS server mid-session" scenario the harness
  // proof drives (see scripts/browser-proof-reconnect.mjs).
  process.on('SIGUSR2', async () => {
    console.log('BOUNCE tearing down the WS/HTTP layer');
    await adapter.teardown();
    await new Promise((r) => setTimeout(r, 200));
    await adapter.setup(setup);
    console.log('BOUNCE WS/HTTP layer back up');
  });

  // Ghost-typing proof release: unblocks a pending 'ghost typing test' turn
  // (see onInbound) so the proof script can decide EXACTLY when the server's
  // typing:false fires, relative to a SIGUSR2 bounce and the SPA's own
  // reconnect — deterministic instead of racing wall-clock delays.
  process.on('SIGUSR1', () => {
    console.log('SIGNAL SIGUSR1 received — releasing ghost-typing test hold, if any');
    if (resolveGhostTypingRelease) {
      const release = resolveGhostTypingRelease;
      resolveGhostTypingRelease = null;
      release();
    }
  });

  const shutdown = async () => {
    await adapter.teardown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
