// Suspect B, take 2: real CONCURRENCY (not sequential awaits). Fires several
// simultaneous "turns" (each: connect -> send -> disconnect, mimicking a
// user who refreshes right after hitting send) at the same time as several
// simultaneous "reload" attempts (connect -> capture until settled ->
// disconnect), all racing against the actual Node event loop instead of one
// operation at a time. If handleUpgrade's callback, or anything around it,
// is ever NOT perfectly synchronous with clients.add()+history-send under
// real concurrent load, this is positioned to catch it.
import WebSocket from 'ws';

const PORT = process.env.NANOCLAW_WEB_PORT ?? '7899';
const TOKEN = process.env.NANOCLAW_WEB_TOKEN;
const ROUNDS = Number(process.env.REPRO_B2_ROUNDS ?? 25);
const CONCURRENCY = Number(process.env.REPRO_B2_CONCURRENCY ?? 6);

function connect() {
  return new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(TOKEN)}`);
}

function applyServerFrame(items, frame) {
  switch (frame.type) {
    case 'message':
      return [...items, { kind: 'message', id: frame.id, content: frame.content }];
    case 'card':
      return [...items, { kind: 'card', id: frame.id, questionId: frame.questionId }];
    default:
      return items;
  }
}

function reduceClientLikeReal(framesInArrivalOrder) {
  let items = [];
  for (const frame of framesInArrivalOrder) {
    if (frame.type === 'history') items = frame.frames.reduce(applyServerFrame, []);
    else if (frame.type === 'ready' || frame.type === 'typing') void 0;
    else items = applyServerFrame(items, frame);
  }
  return items;
}

// One "turn": open a client, wait for ready, send a message, close
// immediately at a random jittered point (0-50ms) — models "hit send, see
// dots, refresh instantly".
async function fireOneTurn() {
  const ws = connect();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('turn sender ready timeout')), 4000);
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'ready') {
        clearTimeout(t);
        ws.send(JSON.stringify({ type: 'user_message', text: 'ship it' }));
        resolve();
      }
    });
    ws.on('error', reject);
  });
  await new Promise((r) => setTimeout(r, Math.random() * 50));
  ws.close();
}

// One "reload": open a client at a random jittered point, capture whatever
// arrives until a card is seen (live or in history), then reconstruct.
async function fireOneReload() {
  await new Promise((r) => setTimeout(r, Math.random() * 550));
  const ws = connect();
  const received = [];
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      // Not every reload will land in time to see the card — that's fine,
      // this fuzzer only flags an actual CONTRADICTION vs ground truth, not
      // an incomplete-but-consistent snapshot. Resolve with whatever we have.
      resolve();
    }, 1200);
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      received.push(frame);
      const cardSeen = frame.type === 'card' || (frame.type === 'history' && frame.frames.some((f) => f.type === 'card'));
      if (cardSeen) {
        setTimeout(() => {
          clearTimeout(t);
          resolve();
        }, 100);
      }
    });
    ws.on('error', () => resolve());
  });
  ws.close();
  return reduceClientLikeReal(received);
}

async function groundTruth() {
  const ws = connect();
  const frames = await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ground truth timeout')), 3000);
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'history') {
        clearTimeout(t);
        resolve(frame.frames);
      }
    });
    ws.on('error', reject);
  });
  ws.close();
  return frames;
}

async function main() {
  let contradictions = 0;
  let totalReloadsWithCard = 0;

  for (let round = 0; round < ROUNDS; round++) {
    const turns = Array.from({ length: CONCURRENCY }, () => fireOneTurn());
    const reloads = Array.from({ length: CONCURRENCY }, () => fireOneReload());
    const [, reloadResults] = await Promise.all([Promise.all(turns), Promise.all(reloads)]);

    // Let everything fully settle before reading ground truth.
    await new Promise((r) => setTimeout(r, 300));
    const truth = await groundTruth();
    const truthMarkdownIds = new Set(truth.filter((f) => f.type === 'message').map((f) => f.id));
    const truthCardIds = new Set(truth.filter((f) => f.type === 'card').map((f) => f.id));

    for (const items of reloadResults) {
      const cardItems = items.filter((i) => i.kind === 'card');
      if (cardItems.length === 0) continue; // reload didn't settle in time, not a contradiction
      totalReloadsWithCard++;
      // Contradiction = a reload claims a card/message id that ground truth
      // does NOT have (fabricated) — the actual "loss" case is symmetric and
      // harder to detect per-reload since different reloads may legitimately
      // see different subsets depending on timing; the real invariant we can
      // assert cheaply is "nothing appears that isn't real".
      for (const item of cardItems) {
        if (!truthCardIds.has(item.id)) {
          contradictions++;
          console.error(`CONTRADICTION round=${round}: reload saw card id=${item.id} not in ground truth`);
        }
      }
      for (const item of items.filter((i) => i.kind === 'message')) {
        if (!truthMarkdownIds.has(item.id)) {
          contradictions++;
          console.error(`CONTRADICTION round=${round}: reload saw message id=${item.id} not in ground truth`);
        }
      }
    }
    console.log(`round ${round + 1}/${ROUNDS}: ground truth has ${truthMarkdownIds.size} messages, ${truthCardIds.size} cards`);
  }

  console.log(`\n${contradictions} contradictions across ${ROUNDS} rounds x ${CONCURRENCY} concurrent turns/reloads (${totalReloadsWithCard} reloads settled with a card).`);
  if (contradictions > 0) {
    console.error('FAIL: concurrent fuzz found client-visible state contradicting server ground truth');
    process.exit(1);
  }
  console.log('PASS: no contradictions found under concurrent load');
  process.exit(0);
}

main().catch((err) => {
  console.error('ERROR', err);
  process.exit(1);
});
