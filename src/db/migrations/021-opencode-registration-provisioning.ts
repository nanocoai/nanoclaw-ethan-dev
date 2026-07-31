import type { Migration } from './index.js';

/**
 * OpenCode-only provisioning for channel-approved agent groups.
 *
 * Provider rows are operator-owned connections, not model allowlists. The
 * registration wizard discovers models live, then copies the selected runtime
 * settings into container_configs rather than retaining a live reference.
 *
 * The pending-row columns make the name -> model provider -> model -> confirm
 * flow restart-safe. Existing rows resolve to `idle` and preserve the old
 * connect-existing/reject behavior.
 */
export const migration021: Migration = {
  version: 21,
  name: 'opencode-registration-provisioning',
  up(db) {
    db.exec(`
      CREATE TABLE opencode_model_providers (
        id                TEXT PRIMARY KEY,
        name              TEXT NOT NULL UNIQUE,
        provider_id       TEXT NOT NULL,
        discovery_type    TEXT NOT NULL DEFAULT 'models-dev'
                          CHECK (discovery_type IN ('models-dev', 'openai-compatible')),
        base_url          TEXT,
        models_url        TEXT,
        context_limit     INTEGER,
        output_limit      INTEGER,
        input_modalities  TEXT NOT NULL DEFAULT '',
        instructions      TEXT,
        enabled           INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );

      CREATE INDEX idx_opencode_model_providers_enabled
        ON opencode_model_providers(enabled, name);

      ALTER TABLE container_configs
        ADD COLUMN provider_settings TEXT NOT NULL DEFAULT '{}';

      ALTER TABLE pending_channel_approvals
        ADD COLUMN provisioning_step TEXT NOT NULL DEFAULT 'idle';
      ALTER TABLE pending_channel_approvals
        ADD COLUMN new_agent_name TEXT;
      ALTER TABLE pending_channel_approvals
        ADD COLUMN selected_provider_id TEXT;
      ALTER TABLE pending_channel_approvals
        ADD COLUMN selected_model_id TEXT;
    `);
  },
};
