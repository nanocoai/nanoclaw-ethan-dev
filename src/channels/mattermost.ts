/**
 * Mattermost channel adapter (v2) — uses Chat SDK bridge.
 * Self-registers on import.
 *
 * Transports (see spec §4): inbound messages arrive over an outbound
 * WebSocket (Slack Socket-Mode analogue — no inbound port needed for text).
 * Button clicks are different: Mattermost's interactive-message callback is
 * always an inbound HTTP POST from the server to MATTERMOST_CALLBACK_URL, so
 * that URL must be externally reachable from the Mattermost instance.
 */
import { createMattermostAdapter } from 'chat-adapter-mattermost';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

/**
 * Dedicated bot account on a threaded platform. group threads:true keeps
 * mention-sticky bounded — engagement sticks per-thread, not forever.
 * dm.threads:false is a deliberate policy choice, not a capability limit:
 * Mattermost DMs can hold sub-threads (RootId), but by default the agent
 * replies top-level and all DM sub-threads collapse into the one DM session.
 * mentions:'platform' — Mattermost delivers mention metadata on the `posted`
 * event rather than requiring name-regex matching.
 */
const MATTERMOST_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention-sticky', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

registerChannelAdapter('mattermost', {
  factory: () => {
    const env = readEnvFile(['MATTERMOST_URL', 'MATTERMOST_BOT_TOKEN', 'MATTERMOST_CALLBACK_URL', 'MATTERMOST_TEAM']);
    if (!env.MATTERMOST_URL || !env.MATTERMOST_BOT_TOKEN) return null;
    // The values come from the host's .env file, not process.env, so they are
    // handed to the factory explicitly. It returns null when it ends up with
    // no URL or no token — the same "channel not configured" answer as the
    // guard above, re-checked here because the factory owns that contract.
    const mattermostAdapter = createMattermostAdapter({
      url: env.MATTERMOST_URL,
      botToken: env.MATTERMOST_BOT_TOKEN,
      callbackUrl: env.MATTERMOST_CALLBACK_URL,
      team: env.MATTERMOST_TEAM,
    });
    if (!mattermostAdapter) return null;
    const bridge = createChatSdkBridge({
      adapter: mattermostAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      defaults: MATTERMOST_DEFAULTS,
    });
    bridge.resolveChannelName = async (platformId: string) => {
      try {
        const info = await mattermostAdapter.fetchThread(platformId);
        return (info as { channelName?: string }).channelName ?? null;
      } catch {
        return null;
      }
    };
    return bridge;
  },
  defaults: MATTERMOST_DEFAULTS,
});
