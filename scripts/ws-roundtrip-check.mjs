// Headless backend round-trip check: connects as a browser would, drives the
// full inbound -> deliver(markdown) -> deliver(card) -> click -> onAction loop.
import WebSocket from 'ws';

const PORT = process.env.NANOCLAW_WEB_PORT ?? '7890';
const TOKEN = process.env.NANOCLAW_WEB_TOKEN;

function connect(token) {
  return new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
}

async function main() {
  // 1. Bad token: the server completes the WS handshake (so the browser
  // gets a real close code, not an opaque 1006) then immediately closes with
  // app-level code 4401 — see web.ts's upgrade handler.
  await new Promise((resolve, reject) => {
    const bad = connect('wrong-token');
    const timer = setTimeout(() => reject(new Error('timeout waiting for 4401 close')), 5000);
    bad.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 4401) {
        console.error(`FAIL: expected close code 4401 for bad token, got ${code}`);
        process.exit(1);
      }
      console.log('OK   bad token rejected with close 4401');
      resolve();
    });
    bad.on('error', () => {
      // The `ws` client library may also raise a benign error event around
      // the close; the close-code assertion above is the real check.
    });
  });

  // 2. Good token: full round trip.
  const ws = connect(TOKEN);
  const frames = [];
  let questionId = null;

  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for card')), 5000);
    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'user_message', text: 'ship it' }));
    });
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      frames.push(frame.type);
      if (frame.type === 'message') console.log(`OK   markdown message frame (${frame.content.length} chars)`);
      if (frame.type === 'card') {
        questionId = frame.questionId;
        const styles = frame.options.map((o) => `${o.index}:${o.label}[${o.style ?? 'default'}]`).join(' ');
        console.log(`OK   card frame  qid=${questionId}  options: ${styles}`);
        clearTimeout(timer);
        resolve();
      }
    });
    ws.on('error', reject);
  });

  // 3. Click option index 0 (Approve) — actionId matches the bridge encoding.
  const actionId = `ncq:${questionId}:0`;
  ws.send(JSON.stringify({ type: 'action', actionId }));
  console.log(`OK   sent click actionId=${actionId}`);

  // 4. Expect a card_resolved frame back.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for card_resolved')), 3000);
    ws.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'card_resolved') {
        console.log(`OK   card_resolved  selectedLabel="${frame.selectedLabel}"  actor=${frame.actor}`);
        clearTimeout(timer);
        resolve();
      }
    });
  });

  ws.close();
  console.log('DONE headless round-trip complete');
  process.exit(0);
}

main().catch((err) => {
  console.error('FAIL', err);
  process.exit(1);
});
