// Suspect B repro: snapshot/subscribe race + client-side pre-'ready' frame
// handling. Reconnects (fresh client, like a reload) at many different
// offsets *during* an in-flight turn (typing -> markdown -> card, ~500ms),
// replays the exact client reducer (copied verbatim from useNanoclaw.ts
// applyServerFrame) over whatever frames that connection actually receives
// in wire order, and compares the reconstructed conversation against the
// server's ground-truth history at the end of the run.
//
// This also directly answers the task's explicit question: "does a
// `message` frame arriving pre-'ready' get applied or discarded?" — frames
// are fed to the reducer in raw arrival order, exactly as ws.onmessage would.
import WebSocket from 'ws';

const PORT = process.env.NANOCLAW_WEB_PORT ?? '7899';
const TOKEN = process.env.NANOCLAW_WEB_TOKEN;
const ITERATIONS = Number(process.env.REPRO_B_ITERATIONS ?? 40);

function connect() {
  return new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(TOKEN)}`);
}

// ---- copied verbatim from src/channels/web-ui/src/useNanoclaw.ts ----
function applyServerFrame(items, frame) {
  switch (frame.type) {
    case 'message':
      return [...items, { kind: 'message', id: frame.id, role: 'assistant', content: frame.content }];
    case 'card':
      return [
        ...items,
        {
          kind: 'card',
          id: frame.id,
          questionId: frame.questionId,
          title: frame.title,
          question: frame.question,
          options: frame.options,
          pending: false,
        },
      ];
    case 'generic_card':
      return [
        ...items,
        { kind: 'generic_card', id: frame.id, title: frame.title, body: frame.body, links: frame.links, fallbackText: frame.fallbackText },
      ];
    case 'card_resolved':
      return items.map((item) =>
        item.kind === 'card' && item.questionId === frame.questionId
          ? { ...item, pending: false, resolution: { selectedIndex: frame.selectedIndex, selectedLabel: frame.selectedLabel, actor: frame.actor } }
          : item,
      );
    case 'edit': {
      const index = items.findIndex((item) => item.id === frame.id);
      const edited = { kind: 'message', id: frame.id, role: 'assistant', content: frame.content };
      if (index === -1) return [...items, edited];
      const next = items.slice();
      next[index] = edited;
      return next;
    }
    default:
      return items;
  }
}

// Mirrors ws.onmessage's switch: 'history' REPLACES wholesale, everything
// else applies the reducer onto whatever's there.
function reduceClientLikeReal(framesInArrivalOrder) {
  let items = [];
  for (const frame of framesInArrivalOrder) {
    if (frame.type === 'history') {
      items = frame.frames.reduce(applyServerFrame, []);
    } else if (frame.type === 'ready' || frame.type === 'typing') {
      // no item-list effect
    } else {
      items = applyServerFrame(items, frame);
    }
  }
  return items;
}

async function runOnce(delayMs) {
  // Trigger a turn via a throwaway sender client, then immediately drop it —
  // simulating "user hits send, sees typing dots, refreshes".
  const sender = connect();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('sender ready timeout')), 4000);
    sender.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'ready') {
        clearTimeout(t);
        sender.send(JSON.stringify({ type: 'user_message', text: 'ship it' }));
        resolve();
      }
    });
    sender.on('error', reject);
  });
  sender.close();

  // Reconnect ("reload") after `delayMs` — may land before typing, during
  // typing, right at markdown delivery, right at card delivery, or after.
  await new Promise((r) => setTimeout(r, delayMs));
  const reloaded = connect();
  const received = [];
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`reload capture timeout (delay=${delayMs})`)), 3000);
    reloaded.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      received.push(frame);
      // Turn is fully done (harness delivers markdown then card, in that
      // order) once a 'card' shows up either live or already folded into a
      // 'history' replay snapshot — settle a bit longer in case anything
      // trails, then resolve.
      const cardSeen = frame.type === 'card' || (frame.type === 'history' && frame.frames.some((f) => f.type === 'card'));
      if (cardSeen) {
        setTimeout(() => {
          clearTimeout(t);
          resolve();
        }, 200);
      }
    });
    reloaded.on('error', reject);
  });
  reloaded.close();

  const reconstructed = reduceClientLikeReal(received);

  // Ground truth: reconnect one more time, well after everything has settled,
  // and read the server's history array directly.
  await new Promise((r) => setTimeout(r, 150));
  const truthConn = connect();
  const truthHistory = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ground truth timeout')), 3000);
    truthConn.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'history') {
        clearTimeout(t);
        resolve(frame.frames);
      }
    });
    truthConn.on('error', reject);
  });
  truthConn.close();

  const truthHasMarkdown = truthHistory.some((f) => f.type === 'message' && f.content?.includes('deploy summary'));
  const truthHasCard = truthHistory.some((f) => f.type === 'card');
  const reconstructedHasMarkdown = reconstructed.some((i) => i.kind === 'message' && i.content?.includes('deploy summary'));
  const reconstructedHasCard = reconstructed.some((i) => i.kind === 'card');

  return {
    delayMs,
    receivedTypes: received.map((f) => f.type),
    truthHasMarkdown,
    truthHasCard,
    reconstructedHasMarkdown,
    reconstructedHasCard,
    lost: (truthHasMarkdown && !reconstructedHasMarkdown) || (truthHasCard && !reconstructedHasCard),
  };
}

async function main() {
  const results = [];
  for (let i = 0; i < ITERATIONS; i++) {
    // Sweep the reconnect delay across the whole turn window (0-650ms) so we
    // hit: pre-typing, mid-typing, right-at-markdown-delivery,
    // right-at-card-delivery, and post-turn.
    const delayMs = Math.round((i / (ITERATIONS - 1)) * 650);
    const r = await runOnce(delayMs);
    results.push(r);
    const tag = r.lost ? 'LOST' : 'ok  ';
    console.log(
      `[${tag}] delay=${String(r.delayMs).padStart(4)}ms  received=[${r.receivedTypes.join(',')}]  ` +
        `truth(md=${r.truthHasMarkdown},card=${r.truthHasCard})  reconstructed(md=${r.reconstructedHasMarkdown},card=${r.reconstructedHasCard})`,
    );
  }

  const losses = results.filter((r) => r.lost);
  console.log(`\n${losses.length}/${results.length} iterations LOST a frame that was in server ground truth.`);
  if (losses.length > 0) {
    console.error('FAIL suspect B: reconnect-during-turn can lose a frame client-side vs. server ground truth');
    process.exit(1);
  }
  console.log('PASS suspect B: no reconnect-during-turn iteration lost a ground-truth frame');
  process.exit(0);
}

main().catch((err) => {
  console.error('ERROR', err);
  process.exit(1);
});
