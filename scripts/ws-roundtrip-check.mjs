// Headless backend round-trip check: connects as a browser would, drives the
// full inbound -> deliver(markdown) -> deliver(card) -> click -> onAction loop.
import WebSocket from 'ws';

const PORT = process.env.NANOCLAW_WEB_PORT ?? '7890';
const TOKEN = process.env.NANOCLAW_WEB_TOKEN;

function connect(token) {
  return new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(token)}`);
}

async function main() {
  // 1. Bad token must be rejected at upgrade.
  await new Promise((resolve) => {
    const bad = connect('wrong-token');
    bad.on('open', () => {
      console.error('FAIL: bad token was accepted');
      process.exit(1);
    });
    bad.on('error', () => {
      console.log('OK   bad token rejected at upgrade');
      resolve();
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
