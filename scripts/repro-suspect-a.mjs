// Suspect A repro: deliver() while ZERO clients are connected during a
// mid-turn refresh. Disconnect the only client right after the typing
// indicator flips on (simulating a page refresh while dots animate), wait
// out the whole turn (markdown + card delivery happen with nobody
// connected), then reconnect and check whether history replay includes the
// assistant's answer.
import WebSocket from 'ws';

const PORT = process.env.NANOCLAW_WEB_PORT ?? '7899';
const TOKEN = process.env.NANOCLAW_WEB_TOKEN;

function connect() {
  return new WebSocket(`ws://127.0.0.1:${PORT}/ws?token=${encodeURIComponent(TOKEN)}`);
}

async function main() {
  const ws1 = connect();
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for ready/typing')), 5000);
    let ready = false;
    ws1.on('open', () => {
      // wait for ready before sending, then send the message that triggers the
      // harness's default scenario (setTyping -> 350ms -> deliver markdown ->
      // 150ms -> deliver card).
    });
    ws1.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'ready' && !ready) {
        ready = true;
        ws1.send(JSON.stringify({ type: 'user_message', text: 'ship it' }));
      }
      if (frame.type === 'typing' && frame.on === true) {
        console.log('OK   saw typing:true — simulating refresh (closing client NOW, 0 clients connected)');
        clearTimeout(timer);
        ws1.close();
        resolve();
      }
    });
    ws1.on('error', reject);
  });

  // Whole turn (setTyping -> 350ms -> markdown deliver -> 150ms -> card
  // deliver) takes <600ms in the harness. Wait well past it with ZERO
  // clients connected — this is exactly the disconnect-all-clients-then-
  // deliver scenario for suspect A.
  console.log('..   waiting 1200ms with zero clients connected (agent finishing its turn)');
  await new Promise((r) => setTimeout(r, 1200));

  // Reconnect — a fresh client, exactly like a reloaded page.
  const ws2 = connect();
  const historyFrame = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for history frame')), 5000);
    ws2.on('message', (data) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'history') {
        clearTimeout(timer);
        resolve(frame);
      }
    });
    ws2.on('error', reject);
  });

  const types = historyFrame.frames.map((f) => f.type);
  console.log(`..   history replay contains frame types: [${types.join(', ')}]`);

  const hasMarkdownMessage = historyFrame.frames.some(
    (f) => f.type === 'message' && typeof f.content === 'string' && f.content.includes('deploy summary'),
  );
  const hasCard = historyFrame.frames.some((f) => f.type === 'card');

  ws2.close();

  if (!hasMarkdownMessage || !hasCard) {
    console.error(
      `FAIL suspect A: assistant turn delivered while 0 clients connected is MISSING from history replay ` +
        `(hasMarkdownMessage=${hasMarkdownMessage}, hasCard=${hasCard})`,
    );
    process.exit(1);
  }

  console.log('PASS suspect A: assistant turn delivered while 0 clients connected IS present in history replay');
  process.exit(0);
}

main().catch((err) => {
  console.error('ERROR', err);
  process.exit(1);
});
