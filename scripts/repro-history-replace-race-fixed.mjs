// Same adversarial scenario as repro-history-replace-race.mjs, run against
// the FIXED reducer (mergeHistoryFrames + seq dedupe, copied verbatim from
// src/channels/web-ui/src/useNanoclaw.ts). Must PASS where the pre-fix
// script fails.

// ---- copied verbatim from src/channels/web-ui/src/useNanoclaw.ts (post-fix) ----
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

function hasSeq(frame) {
  return frame.type !== 'ready' && frame.type !== 'typing' && frame.type !== 'history';
}

function mergeHistoryFrames(alreadyApplied, replayed) {
  const bySeq = new Map();
  for (const frame of alreadyApplied) bySeq.set(frame.seq, frame);
  for (const frame of replayed) if (hasSeq(frame)) bySeq.set(frame.seq, frame);
  return [...bySeq.values()].sort((a, b) => a.seq - b.seq);
}

function reduceClientLikeReal_postFix(framesInArrivalOrder) {
  let items = [];
  let frameLog = [];
  let seenSeqs = new Set();
  for (const frame of framesInArrivalOrder) {
    if (frame.type === 'history') {
      const merged = mergeHistoryFrames(frameLog, frame.frames);
      frameLog = merged;
      seenSeqs = new Set(merged.map((f) => f.seq));
      items = merged.reduce(applyServerFrame, []);
    } else if (frame.type === 'ready' || frame.type === 'typing') {
      // no item-list effect
    } else {
      if (seenSeqs.has(frame.seq)) continue; // idempotent
      seenSeqs.add(frame.seq);
      frameLog = [...frameLog, frame];
      items = applyServerFrame(items, frame);
    }
  }
  return items;
}

function main() {
  // Identical adversarial ordering to the pre-fix repro: a live 'message'
  // frame is applied, THEN a 'history' snapshot arrives that predates it
  // (frames: []) — e.g. a slower snapshot build, a duplicated/late resend.
  const frames = [
    { type: 'ready', threadId: null },
    { type: 'message', id: 'msg-1', role: 'assistant', content: 'deploy summary: here is your answer', seq: 5 },
    { type: 'history', frames: [] },
  ];

  const items = reduceClientLikeReal_postFix(frames);
  const hasAnswer = items.some((i) => i.kind === 'message' && i.id === 'msg-1');
  console.log(`items after replay: ${JSON.stringify(items)}`);

  if (!hasAnswer) {
    console.error('FAIL: post-fix reducer STILL lost the live frame to a stale history snapshot');
    process.exit(1);
  }

  // Also prove idempotency: replaying the SAME live frame again (e.g. a
  // duplicate send) must not duplicate it in items.
  const framesWithDuplicate = [...frames, { type: 'message', id: 'msg-1', role: 'assistant', content: 'deploy summary: here is your answer', seq: 5 }];
  const itemsAfterDuplicate = reduceClientLikeReal_postFix(framesWithDuplicate);
  const count = itemsAfterDuplicate.filter((i) => i.kind === 'message' && i.id === 'msg-1').length;
  console.log(`count of msg-1 after a duplicate resend: ${count}`);
  if (count !== 1) {
    console.error(`FAIL: reducer is not idempotent on seq — msg-1 appears ${count} times`);
    process.exit(1);
  }

  // Also prove a genuinely NEW history snapshot (that DOES include the
  // frame, plus a later card) merges correctly with a higher-seq live frame
  // arriving after it (out-of-order network delivery), keeping both.
  const framesOutOfOrderCard = [
    { type: 'ready', threadId: null },
    { type: 'card', id: 'card-1', questionId: 'q1', seq: 7 }, // arrives before the history that already contains msg-1
    { type: 'history', frames: [{ type: 'message', id: 'msg-1', role: 'assistant', content: 'hi', seq: 5 }] },
  ];
  const itemsOutOfOrder = reduceClientLikeReal_postFix(framesOutOfOrderCard);
  const hasBoth = itemsOutOfOrder.some((i) => i.id === 'msg-1') && itemsOutOfOrder.some((i) => i.id === 'card-1');
  console.log(`items (out-of-order card + history): ${JSON.stringify(itemsOutOfOrder)}`);
  if (!hasBoth) {
    console.error('FAIL: merge did not preserve both the higher-seq live card and the history-replayed message');
    process.exit(1);
  }

  console.log('PASS: post-fix reducer survives the reorder, is idempotent on seq, and merges live+history correctly');
  process.exit(0);
}

main();
