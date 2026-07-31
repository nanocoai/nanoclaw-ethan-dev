import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { lookup } from '../registry.js';
import './opencode-model-providers.js';

const hostCtx = { caller: 'host' as const };

describe('OpenCode model provider CLI resource', () => {
  beforeEach(() => {
    const db = initTestDb();
    runMigrations(db);
  });

  afterEach(() => closeDb());

  it('creates a normalized provider connection without model or credential fields', async () => {
    const row = (await lookup('opencode-model-providers-create')!.handler(
      {
        name: 'Spark local',
        provider_id: 'OpenAI',
        discovery_type: 'openai-compatible',
        base_url: 'https://inference.example.test/v1/',
        context_limit: '65536',
        output_limit: '8192',
        input_modalities: 'image,text,image',
      },
      hostCtx,
    )) as Record<string, unknown>;

    expect(row).toMatchObject({
      name: 'Spark local',
      provider_id: 'openai',
      discovery_type: 'openai-compatible',
      base_url: 'https://inference.example.test/v1',
      context_limit: 65536,
      output_limit: 8192,
      input_modalities: 'image,text',
      enabled: 1,
    });
    expect(row).not.toHaveProperty('model');
    expect(row).not.toHaveProperty('api_key');
    expect(row).not.toHaveProperty('credential');
  });

  it('rejects endpoint discovery without a base or models URL', async () => {
    await expect(
      lookup('opencode-model-providers-create')!.handler(
        { name: 'Broken local', provider_id: 'openai', discovery_type: 'openai-compatible' },
        hostCtx,
      ),
    ).rejects.toThrow('openai-compatible discovery requires base_url or models_url');
  });

  it('validates the merged provider during a partial update', async () => {
    const created = (await lookup('opencode-model-providers-create')!.handler(
      { name: 'Cloud', provider_id: 'google' },
      hostCtx,
    )) as { id: string };

    await expect(
      lookup('opencode-model-providers-update')!.handler(
        { id: created.id, discovery_type: 'openai-compatible' },
        hostCtx,
      ),
    ).rejects.toThrow('openai-compatible discovery requires base_url or models_url');
  });
});
