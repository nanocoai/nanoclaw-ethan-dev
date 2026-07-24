// Client-reducer idempotency repro. Exhaustive server-side testing
// (repro-suspect-a.mjs, repro-suspect-b.mjs, repro-suspect-b-concurrent.mjs,
// browser-proof-refresh-mid-turn.mjs) found bb8d6242's server-side ring
// buffer (append-before-broadcast) and subscribe-before-snapshot ordering
// ALREADY correct — none of those reproduce a loss.
//
// This script instead targets the client reducer directly (useNanoclaw.ts's
// ws.onmessage switch + applyServerFrame), copied verbatim from the PRE-FIX
// source. It proves the reducer itself is not defensive against frame
// reordering: a 'history' frame arriving without a live frame the client
// already applied WIPES that live frame from the conversation, because
// the 'history' case does an unconditional wholesale replace instead of a
// seq-aware merge. This is exactly the hardening the fix requirements call
// for ("make the client reducer idempotent on seq so replay+live overlap is
// safe") — a real, deterministic defect, independent of whether today's
// synchronous server code can trigger the ordering on its own.
//
// Run BEFORE the fix (imports the OLD reducer copy below) to see it fail;
// after the fix, scripts/repro-history-replace-race-fixed.mjs (same
// scenario against the new merge logic) must pass.

// ---- copied verbatim from src/channels/web-ui/src/useNanoclaw.ts (pre-fix) ----
function applyServerFrame(items, frame) {
  switch (frame.type) {
    case 'message':
      return [...items, { kind: 'message', id: frame.id, role: 'assistant', content: frame.content }];
    case 'card':
      return [...items, { kind: 'card', id: frame.id, questionId: frame.questionId, pending: false }];
    default:
      return items;
  }
}

function reduceClientLikeReal_preFix(framesInArrivalOrder) {
  let items = [];
  for (const frame of framesInArrivalOrder) {
    if (frame.type === 'history') {
      // pre-fix: unconditional wholesale replace, no merge with what's
      // already applied.
      items = frame.frames.reduce(applyServerFrame, []);
    } else if (frame.type === 'ready' || frame.type === 'typing') {
      // no item-list effect
    } else {
      items = applyServerFrame(items, frame);
    }
  }
  return items;
}

function main() {
  // Adversarial-but-legitimate ordering: a live 'message' frame (the agent's
  // answer, arriving right as the connection is established — exactly the
  // "delivering during the connect handshake" scenario the task calls out)
  // is applied by the client BEFORE a 'history' snapshot that doesn't (yet)
  // include it arrives — e.g. a slightly slower snapshot build, a proxy that
  // reorders unrelated writes, or simply a second 'history' resend from a
  // future server change. Whatever the trigger, the reducer must survive it.
  const frames = [
    { type: 'ready', threadId: null },
    { type: 'message', id: 'msg-1', role: 'assistant', content: 'deploy summary: here is your answer' },
    { type: 'history', frames: [] }, // snapshot taken before msg-1 was recorded
  ];

  const items = reduceClientLikeReal_preFix(frames);
  const hasAnswer = items.some((i) => i.kind === 'message' && i.id === 'msg-1');

  console.log(`items after replay: ${JSON.stringify(items)}`);
  if (!hasAnswer) {
    console.error(
      'FAIL: pre-fix reducer is NOT idempotent on reorder — a live frame the client already ' +
        'applied was wiped by a later history snapshot that predates it.',
    );
    process.exit(1);
  }
  console.log('PASS: reducer survived the reorder (unexpected for pre-fix code — check you copied the right logic)');
  process.exit(0);
}

main();
