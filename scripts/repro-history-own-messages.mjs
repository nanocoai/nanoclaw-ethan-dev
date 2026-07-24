// P1b repro: the operator's OWN messages were never recorded into the web
// channel's replay history (found during P1a — runbooks/dgx-spark-demo
// TODO.md P1b / memory dgx-spark-demo-workstream). A page refresh dropped
// the user's half of the conversation because handleClientFrame's
// user_message branch only ever called config.onInbound(...) directly — it
// never went through emit() (the same recorder+broadcaster the assistant
// side already relies on), so the message never got a seq, never landed in
// `history`, and was never even echoed back live.
//
// Two properties proven against a REAL running harness (headless — this is a
// server-contract + reducer-contract test, not a rendering test; Message.tsx
// already renders role:'user' items as user bubbles unchanged, see
// components/Message.tsx):
//
//   A. LIVE ECHO + DEDUPE: the client's optimistic local echo (pushed the
//      instant sendMessage() fires, before any server round-trip — see
//      useNanoclaw.ts sendMessage) and the server's recorded frame for the
//      SAME send carry the same id (the clientId round-trip: web.ts echoes
//      it back on the MessageFrame) and must collapse to ONE item, not two,
//      once the live echo lands on the same connection.
//   B. REFRESH SURVIVES: closing the connection entirely and reconnecting
//      fresh (exactly what a hard page reload does — zero client state
//      carries over) must still show the user's message via the 'history'
//      replay.
//
// Run against 127e1638 (git stash push -- src/channels/web.ts reverts the
// adapter to that commit's content; restart the harness) to see BOTH phases
// FAIL — the literal reported bug: no echo, no replay. Run against the fix
// (git stash pop; restart the harness) to see both PASS.
import WebSocket from 'ws';

const PORT = process.env.NANOCLAW_WEB_PORT ?? '7890';
const TOKEN = process.env.NANOCLAW_WEB_TOKEN;
const SENT_TEXT = `p1b probe ${Date.now()}`;
const CLIENT_ID = `local-${Date.now()}-${Math.round(Math.random() * 1e6)}`;

function connect() {
  return new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(TOKEN)}`);
}

// ---- copied verbatim from src/channels/web-ui/src/useNanoclaw.ts (post-fix
// applyServerFrame 'message' case): find-or-append by id, so a frame that
// echoes an id already in `items` (the local optimistic echo) replaces it in
// place instead of appending a duplicate. ----
function applyMessageFrame(items, frame) {
  const index = items.findIndex((item) => item.id === frame.id);
  const applied = { kind: 'message', id: frame.id, role: frame.role, content: frame.content };
  if (index === -1) return [...items, applied];
  const next = items.slice();
  next[index] = applied;
  return next;
}

let failures = 0;

async function phaseA() {
  // Simulate useNanoclaw.ts sendMessage(): the optimistic local echo is
  // pushed FIRST, synchronously, before any server round-trip.
  let items = [{ kind: 'message', id: CLIENT_ID, role: 'user', content: SENT_TEXT }];

  const ws = connect();
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });

  const echoOrTimeout = await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), 3000);
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'message' && frame.role === 'user' && frame.content === SENT_TEXT) {
        clearTimeout(timer);
        resolve(frame);
      }
    });
    ws.send(JSON.stringify({ type: 'user_message', text: SENT_TEXT, clientId: CLIENT_ID }));
  });

  if (!echoOrTimeout) {
    console.error("FAIL A: no live echo frame ever arrived for the operator's own message (bug: never recorded/broadcast)");
    failures++;
  } else {
    items = applyMessageFrame(items, echoOrTimeout);
    const userItems = items.filter((i) => i.id === CLIENT_ID);
    if (userItems.length !== 1) {
      console.error(`FAIL A: local echo + live echo did not dedupe — ${userItems.length} items for id=${CLIENT_ID}`);
      failures++;
    } else {
      console.log(`OK   A: live echo received + deduped against local optimistic echo (seq=${echoOrTimeout.seq})`);
    }
  }

  ws.close();
  await new Promise((r) => setTimeout(r, 200));
}

async function phaseB() {
  // Fresh connection, zero client state carried over — exactly a hard reload.
  const ws = connect();
  const historyFrames = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for history frame')), 5000);
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'history') {
        clearTimeout(timer);
        resolve(frame.frames);
      }
    });
    ws.on('error', reject);
  });

  const rebuilt = historyFrames.filter((f) => f.type === 'message').reduce(applyMessageFrame, []);
  const found = rebuilt.find((i) => i.role === 'user' && i.content === SENT_TEXT);

  if (!found) {
    console.error("FAIL B: history replay after reconnect does NOT include the operator's own message — THE REPORTED BUG");
    failures++;
  } else {
    console.log(`OK   B: history replay includes the operator's message as a user bubble (id=${found.id})`);
  }

  ws.close();
}

async function main() {
  await phaseA();
  await phaseB();
  if (failures > 0) {
    console.error(`FAIL: ${failures} phase(s) failed`);
    process.exit(1);
  }
  console.log("PASS: the operator's own messages survive both live-echo dedupe and reload replay");
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
