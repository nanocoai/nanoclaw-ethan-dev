<!-- PUBLISH GATE: package not yet on npm -->

---
name: add-mattermost
description: Add Mattermost channel integration via Chat SDK. Works with any self-hosted Mattermost instance (Team Edition or Enterprise).
---

# Add Mattermost Channel

Adds Mattermost support via the Chat SDK bridge.

## Install

NanoClaw doesn't ship channels in trunk. This skill copies the Mattermost adapter in from the `channels` branch.

### Pre-flight (idempotent)

Skip to **Credentials** if all of these are already in place:

- `src/channels/mattermost.ts` exists
- `src/channels/index.ts` contains `import './mattermost.js';`
- `chat-adapter-mattermost` is listed in `package.json` dependencies

Otherwise continue. Every step below is safe to re-run.

### 1. Fetch the channels branch

```bash
git fetch origin channels
```

### 2. Copy the adapter

```bash
git show origin/channels:src/channels/mattermost.ts > src/channels/mattermost.ts
```

### 3. Append the self-registration import

Append to `src/channels/index.ts` (skip if the line is already present):

```typescript
import './mattermost.js';
```

### 4. Install the adapter package (pinned)

```bash
pnpm install chat-adapter-mattermost@0.0.1
```

### 5. Build

```bash
pnpm run build
```

## Credentials

The bot needs its own Mattermost account — a native **bot account**, not a personal login. Bot accounts authenticate with a token instead of a password and don't count against user seats on most licenses.

### Enable bot accounts and tokens

As a System Admin:

1. **System Console** > **Integrations** > **Bot Accounts** — set **Enable Bot Account Creation** to true
2. **System Console** > **Integrations** > **Integration Management** — set **Enable Personal Access Tokens** to true (bot tokens are personal access tokens under the hood)

### Create the bot account

1. **Product menu** > **Integrations** > **Bot Accounts** > **Add Bot Account**
2. Pick a username (e.g. `nanoclaw`), optionally a display name/description/icon
3. Role: **Member** is enough unless the bot needs to see every channel on the instance, in which case use **System Admin**
4. Click **Create Bot Account**, then **copy the access token immediately** — Mattermost shows it once and never again
5. Invite the bot to each team it should work in: team dropdown > **Invite People** > **Invite Member** > the bot's username

### Configure environment

```bash
MATTERMOST_URL=https://mattermost.example.com
MATTERMOST_BOT_TOKEN=the-bot-access-token
MATTERMOST_CALLBACK_URL=https://your-domain     # only needed for button callbacks (approval cards) — see below
MATTERMOST_TEAM=your-team-name                  # optional, scopes the bot to one team
```

Sync to container: `mkdir -p data/env && cp .env data/env/env`

Prefer the OneCLI Agent Vault over `.env` for the bot token wherever your install has it set up (`/init-onecli`). As of this writing the channel adapters — Mattermost included — read credentials straight out of `.env` via `readEnvFile`, so there's no vault-backed path for channel tokens yet; treat `MATTERMOST_BOT_TOKEN` like any other bot secret until that lands.

### Webhook server (button callbacks only)

Plain messages arrive over an outbound WebSocket the adapter opens to Mattermost — no inbound port needed, same shape as Slack's Socket Mode. **Button clicks are different**: an approval card's buttons are always delivered as an inbound HTTP POST from the Mattermost server to `MATTERMOST_CALLBACK_URL`, because Mattermost — not the client — owns interactive-message callbacks. Skip this whole section if you don't need approval cards; plain text still works with no callback URL set.

The Chat SDK bridge automatically starts a shared webhook server on port 3000 (configurable via `WEBHOOK_PORT`) that serves `/webhook/mattermost` for this adapter alongside any other webhook-based channel. `MATTERMOST_CALLBACK_URL` can be either that base URL (the adapter appends `/webhook/mattermost` itself) or the full route already — either form works.

This URL must be reachable **from the Mattermost server**, not from your browser. Both NanoClaw and Mattermost are usually self-hosted on the same network, so this is normally just "make sure the port is open," but two Mattermost server settings can still block it:

- **`ServiceSettings.AllowedUntrustedInternalConnections`** (System Console > Environment > Developer, or directly in `config.json`) — Mattermost refuses outbound requests to private/internal addresses by default. If `MATTERMOST_CALLBACK_URL` points at a LAN IP, `localhost`, or a tailnet host, add that host/IP here (host or CIDR, not a full URL — e.g. `nanoclaw.internal` or `192.168.1.50`, not `https://192.168.1.50`).
- **`ServiceSettings.EnableInsecureOutgoingConnections`** (System Console > Environment > Web Server) — only if `MATTERMOST_CALLBACK_URL` is HTTPS with a self-signed certificate. Without this, Mattermost's outbound TLS verification rejects the callback.

Both require a Mattermost server restart if edited in `config.json` directly. See VERIFY.md for the symptom this causes and how to confirm which of these is the problem.

## Next Steps

If you're in the middle of `/setup`, return to the setup flow now.

Otherwise, run `/manage-channels` to wire this channel to an agent group.

## Channel Info

- **type**: `mattermost`
- **terminology**: Mattermost has "teams" containing "channels." Channels can be public (`O`), private (`P`), or direct/group messages (`D`/`G`). Messages that reply to a post form a "thread" rooted at that post.
- **platform-id-format**: `mattermost:{channelId}` for a channel or DM, `mattermost:{channelId}:{rootId}` for a specific thread (e.g. `mattermost:abc123def456...`)
- **how-to-find-id**: Click the channel name at the top > **View Info** — the panel shows the Channel ID. Or **System Console** > **User Management** > **Channels**, search by channel name (ID search isn't supported there).
- **supports-threads**: yes (`Post.RootId`)
- **typical-use**: Interactive chat — team channels or direct messages. Requires a dedicated bot account (bots can't DM from a human's own login).
- **default-isolation**: Same agent group for channels where you're the primary user. Separate agent group for channels with different teams or sensitive contexts.
