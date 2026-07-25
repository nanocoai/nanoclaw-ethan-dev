# Verify Mattermost

## Plain text

Add the bot to a channel and send a message (or @-mention it, depending on engage mode), then send it a direct message. The bot should respond to both within a few seconds.

## Button callbacks (only if you set `MATTERMOST_CALLBACK_URL`)

This is the one failure mode that's otherwise silent: **a card whose buttons do nothing when clicked** is the expected symptom when Mattermost can't reach `MATTERMOST_CALLBACK_URL` — no error surfaces in NanoClaw or in the Mattermost UI, because the click never arrives.

Trigger an approval card (any flow that calls `ask_question`), then click a button. If nothing happens:

1. From a shell **on the Mattermost server itself** (not your laptop), confirm it can actually reach NanoClaw:

   ```bash
   curl -i -X POST http://<nanoclaw-host>:3000/webhook/mattermost \
     -H 'content-type: application/json' \
     -d '{}'
   ```

   A `400 Bad request` or similar response from NanoClaw means the network path is fine — the adapter received the probe and rejected it for lacking a real payload, which is expected. A connection error, timeout, or no response at all means the Mattermost server cannot reach that host/port; fix the network path (firewall, port, DNS) before going further.

2. If the curl above works but real clicks still don't, check the Mattermost server log for `address forbidden` — that's `AllowedUntrustedInternalConnections` blocking the callback URL server-side (see SKILL.md). Add the callback host to that setting and restart Mattermost.

3. If the callback URL is HTTPS with a self-signed cert, also check the log for a TLS/certificate verification error — that's `EnableInsecureOutgoingConnections` (see SKILL.md).

A successful click resolves the card in place (the buttons disappear, replaced by the chosen answer) within a couple seconds.
