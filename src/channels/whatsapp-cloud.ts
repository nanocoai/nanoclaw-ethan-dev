/**
 * WhatsApp Cloud API channel adapter (v2) — uses Chat SDK bridge.
 * Uses the official Meta WhatsApp Business Cloud API (not Baileys).
 * Self-registers on import.
 */
import { createWhatsAppAdapter } from '@chat-adapter/whatsapp';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults, ChannelSetup } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter, getRegisteredChannelNames } from './channel-registry.js';
import { getDb } from '../db/connection.js';
import { log } from '../log.js';

/**
 * Dedicated business number on the official Cloud API — non-threaded, so
 * group engagement defaults to 'mention' (never sticky: one shared session
 * would stay engaged forever).
 */
const WHATSAPP_CLOUD_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

registerChannelAdapter('whatsapp-cloud', {
  factory: () => {
    const env = readEnvFile([
      'WHATSAPP_ACCESS_TOKEN',
      'WHATSAPP_PHONE_NUMBER_ID',
      'WHATSAPP_APP_SECRET',
      'WHATSAPP_VERIFY_TOKEN',
    ]);
    if (!env.WHATSAPP_ACCESS_TOKEN) return null;
    const whatsappAdapter = createWhatsAppAdapter({
      accessToken: env.WHATSAPP_ACCESS_TOKEN,
      phoneNumberId: env.WHATSAPP_PHONE_NUMBER_ID,
      appSecret: env.WHATSAPP_APP_SECRET,
      verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    });
    // `@chat-adapter/whatsapp` hardcodes name = 'whatsapp', which the bridge
    // uses as channelType. Without a distinct instance the registry would key
    // this bridge under 'whatsapp' and collide with the native Baileys adapter
    // (src/channels/whatsapp.ts, also channelType 'whatsapp') — last-write-wins
    // silently kills one channel. The instance key keeps them apart while
    // channelType stays 'whatsapp' (the semantic platform key). See #2911.
    const bridge = createChatSdkBridge({
      adapter: whatsappAdapter,
      instance: 'whatsapp-cloud',
      concurrency: 'concurrent',
      supportsThreads: false,
      defaults: WHATSAPP_CLOUD_DEFAULTS,
    });
    // Adoption must run before the bridge registers webhooks, so the first
    // inbound already resolves the re-keyed rows instead of racing an
    // auto-created duplicate. The re-key targets the instance dimension
    // migration 016 added on installs; adoption checks for the instance column
    // first and no-ops on a pre-016 core.
    const bridgeSetup = bridge.setup.bind(bridge);
    return {
      ...bridge,
      async setup(hostConfig: ChannelSetup) {
        adoptStrandedWhatsAppCloudGroups();
        await bridgeSetup(hostConfig);
      },
    };
  },
  defaults: WHATSAPP_CLOUD_DEFAULTS,
});

/**
 * Stranded rows carry channel_type='whatsapp' AND instance='whatsapp'. The
 * platform_id filter is defense in depth on top of the registry guard: cloud
 * ids are 'whatsapp:{phoneNumberId}:{userWaId}', native Baileys ids are bare
 * JIDs ('<n>@s.whatsapp.net' / '<id>@g.us'), so a 'whatsapp:%' prefix never
 * matches a Baileys row even if one shares the default instance.
 */
const STRANDED_WHERE = `channel_type = 'whatsapp' AND instance = 'whatsapp' AND platform_id LIKE 'whatsapp:%'`;

/**
 * Child tables that REFERENCE messaging_groups(id) and would make a DELETE of
 * a duplicate throw a foreign-key error. All are guaranteed present on any
 * core carrying migration 016 (added by 001/011/012, all before 016), so no
 * table-existence guard is needed. A duplicate is only removable when every
 * one of these holds zero rows for it.
 */
const CHILD_TABLES = ['messaging_group_agents', 'user_dms', 'sessions', 'pending_sender_approvals'] as const;

function countReferencing(table: string, messagingGroupId: string): number {
  return (
    getDb().prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE messaging_group_id = ?`).get(messagingGroupId) as {
      c: number;
    }
  ).c;
}

/**
 * Adopt pre-#2913 default-instance rows into instance='whatsapp-cloud'.
 * Idempotent: once re-keyed no row matches STRANDED_WHERE, so later boots and
 * fresh installs are no-ops.
 */
export function adoptStrandedWhatsAppCloudGroups(): void {
  const db = getDb();

  // The instance dimension only exists on cores carrying migration 016. On an
  // older core messaging_groups has no instance column, so the stranded query
  // below would throw. No column means no strays to adopt: bail quietly.
  const cols = db.prepare(`PRAGMA table_info('messaging_groups')`).all() as Array<{ name: string }>;
  if (!cols.some((c) => c.name === 'instance')) {
    log.info('whatsapp-cloud adoption skipped: messaging_groups has no instance column (pre-016 core)');
    return;
  }

  const stranded = db
    .prepare(`SELECT id, platform_id FROM messaging_groups WHERE ${STRANDED_WHERE}`)
    .all() as Array<{ id: string; platform_id: string }>;

  // A native Baileys 'whatsapp' adapter registered this boot may own rows
  // under the default instance. Never re-key another adapter's rows: warn
  // once if strays exist and leave everything untouched.
  // getRegisteredChannelNames (not getChannelRegistration) because this module
  // is copied onto installs running the core from main, which does not export
  // getChannelRegistration. This name exists on both cores.
  if (getRegisteredChannelNames().includes('whatsapp')) {
    if (stranded.length > 0) {
      log.warn(
        'whatsapp-cloud adoption skipped: native whatsapp adapter is registered; stranded default-instance rows left untouched',
        { count: stranded.length },
      );
    }
    return;
  }

  for (const row of stranded) {
    const collision = db
      .prepare(
        `SELECT id FROM messaging_groups WHERE channel_type = 'whatsapp' AND platform_id = ? AND instance = 'whatsapp-cloud'`,
      )
      .get(row.platform_id) as { id: string } | undefined;

    if (!collision) {
      db.prepare(`UPDATE messaging_groups SET instance = 'whatsapp-cloud' WHERE id = ?`).run(row.id);
      log.info('Adopted stranded whatsapp-cloud messaging group', { id: row.id });
      continue;
    }

    // The collision is a removable router auto-created duplicate only when it
    // carries no wiring and nothing else references it; otherwise deleting it
    // would either destroy real state or throw a foreign-key error mid-setup.
    const blocker = CHILD_TABLES.find((t) => countReferencing(t, collision.id) > 0);

    if (!blocker) {
      // Atomic so a crash between the deletes and the re-key cannot leave the
      // original stranded next to a half-removed duplicate.
      db.transaction(() => {
        db.prepare('DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?').run(collision.id);
        db.prepare('DELETE FROM messaging_groups WHERE id = ?').run(collision.id);
        db.prepare(`UPDATE messaging_groups SET instance = 'whatsapp-cloud' WHERE id = ?`).run(row.id);
      })();
      log.info('Adopted stranded whatsapp-cloud messaging group; removed router auto-created duplicate', {
        id: row.id,
        removedDuplicate: collision.id,
      });
      continue;
    }

    // The duplicate holds real state (referenced by `blocker`). Which row the
    // operator wants is ambiguous, so never guess: leave both and spell out
    // the exact recovery.
    log.warn(
      `whatsapp-cloud adoption skipped for one group: the whatsapp-cloud row is referenced by ${blocker} and cannot be removed automatically. Recover manually with: ncl messaging-groups update ${collision.id} --instance <parked-name> then ncl messaging-groups update ${row.id} --instance whatsapp-cloud`,
      { original: row.id, duplicate: collision.id, blocker },
    );
  }
}
