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
 * Run:  NANOCLAW_WEB_TOKEN=<tok> tsx scripts/web-channel-harness.ts [eventLogPath]
 *
 * Env:
 *   NANOCLAW_WEB_TOKEN  shared token the browser must present (required here)
 *   NANOCLAW_WEB_PORT   listen port (default 7890)
 *   WEB_HARNESS_DATADIR scratch data dir (default ./.harness-data)
 */
import fs from 'fs';
import path from 'path';

import { createWebAdapter } from '../src/channels/web.js';
import type { ChannelSetup, InboundMessage } from '../src/channels/adapter.js';
import { type RawOption } from '../src/channels/ask-question.js';

// ── Copied verbatim from src/modules/approvals/primitive.ts (APPROVAL_OPTIONS,
//    REJECT_WITH_REASON_VALUE) so the card is byte-identical to what core ships.
const REJECT_WITH_REASON_VALUE = 'reject_with_reason';
const APPROVAL_OPTIONS: RawOption[] = [
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve', style: 'primary' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject', style: 'danger' },
  { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: REJECT_WITH_REASON_VALUE },
];

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
  message: { kind: string; content: unknown },
) => Promise<string | undefined>;
let setTyping!: (platformId: string, threadId: string | null) => Promise<void>;

/** Text of an inbound `user_message` — used to pick which demo scenario to play. */
function inboundText(message: InboundMessage): string {
  const content = message.content as Record<string, unknown> | undefined;
  return typeof content?.text === 'string' ? content.text : '';
}

const setup: ChannelSetup = {
  async onInbound(platformId: string, threadId: string | null, message: InboundMessage) {
    record('onInbound', { platformId, threadId, message });

    const text = inboundText(message);

    // Phase-1 parity scenarios (generic card rendering) — everything else
    // falls through to the original markdown + approval card demo below.
    if (text === 'show generic card') {
      await deliver(PLATFORM_ID, null, {
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
      await deliver(PLATFORM_ID, null, {
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
      const messageId = await deliver(PLATFORM_ID, null, {
        kind: 'chat-sdk',
        content: { markdown: 'Original message — about to be edited.' },
      });
      record('editTargetDelivered', { messageId });
      await new Promise((r) => setTimeout(r, 300));
      await deliver(PLATFORM_ID, null, {
        kind: 'chat-sdk',
        content: { operation: 'edit', messageId, text: 'Edited in place — the original text is gone.' },
      });
      record('editApplied', { messageId });
      return;
    }

    if (text === 'edit unknown') {
      // Edit targeting an id the adapter never delivered — the SPA must
      // append it rather than drop it.
      await deliver(PLATFORM_ID, null, {
        kind: 'chat-sdk',
        content: { operation: 'edit', messageId: 'never-delivered-id', text: 'Edit for an id nobody has seen.' },
      });
      record('editForUnknownIdApplied', {});
      return;
    }

    // Play host: acknowledge with a rich markdown message, then an approval card.
    await setTyping(PLATFORM_ID, null);
    await new Promise((r) => setTimeout(r, 350));

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
    await deliver(PLATFORM_ID, null, { kind: 'chat-sdk', content: { markdown } });

    await new Promise((r) => setTimeout(r, 150));

    // The exact payload core delivers (primitive.ts requestApproval()).
    const questionId = `appr-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    await deliver(PLATFORM_ID, null, {
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
  const adapter = createWebAdapter({ dataDir });
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

  const shutdown = async () => {
    await adapter.teardown();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

void main();
