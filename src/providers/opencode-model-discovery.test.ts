import { describe, expect, it, vi } from 'vitest';

import type { OpenCodeModelProvider } from '../types.js';
import { discoverOpenCodeModels } from './opencode-model-discovery.js';

function provider(overrides: Partial<OpenCodeModelProvider> = {}): OpenCodeModelProvider {
  return {
    id: 'provider-1',
    name: 'Test provider',
    provider_id: 'openai',
    discovery_type: 'models-dev',
    base_url: null,
    models_url: null,
    context_limit: null,
    output_limit: null,
    input_modalities: '',
    instructions: null,
    enabled: 1,
    created_at: 'now',
    updated_at: 'now',
    ...overrides,
  };
}

describe('OpenCode model discovery', () => {
  it('reads text-agent models and capability metadata from the live OpenCode catalog shape', async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            google: {
              models: {
                gemini: {
                  id: 'gemini-test',
                  name: 'Gemini Test',
                  modalities: { input: ['text', 'image'], output: ['text'] },
                  limit: { context: 100000, output: 8000 },
                },
                image: {
                  id: 'image-test',
                  modalities: { input: ['text'], output: ['image'] },
                  limit: { context: 1000, output: 1000 },
                },
              },
            },
          }),
        ),
    );

    await expect(discoverOpenCodeModels(provider({ provider_id: 'google' }), fetchImpl)).resolves.toEqual([
      {
        id: 'google/gemini-test',
        name: 'Gemini Test',
        contextLimit: 100000,
        outputLimit: 8000,
        inputModalities: 'text,image',
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'https://models.dev/api.json',
      expect.objectContaining({ headers: undefined }),
    );
  });

  it('queries a custom provider /models endpoint through the OneCLI placeholder credential', async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ id: 'org/local-model' }, { id: 'org/local-model' }] })),
    );

    const models = await discoverOpenCodeModels(
      provider({
        discovery_type: 'openai-compatible',
        base_url: 'http://inference.example.test/v1',
        context_limit: 65536,
        output_limit: 8192,
        input_modalities: 'text,image',
      }),
      fetchImpl,
    );

    expect(models).toEqual([
      {
        id: 'openai/org/local-model',
        name: 'org/local-model',
        contextLimit: 65536,
        outputLimit: 8192,
        inputModalities: 'text,image',
      },
    ]);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://inference.example.test/v1/models',
      expect.objectContaining({ headers: { Authorization: 'Bearer placeholder' } }),
    );
  });

  it('uses an explicit models URL when the provider exposes discovery elsewhere', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ data: [{ id: 'model-a' }] })));
    await discoverOpenCodeModels(
      provider({
        discovery_type: 'openai-compatible',
        base_url: 'https://api.example.test/v1',
        models_url: 'https://catalog.example.test/models',
      }),
      fetchImpl,
    );
    expect(fetchImpl).toHaveBeenCalledWith('https://catalog.example.test/models', expect.any(Object));
  });

  it('uses the OneCLI gateway runner for a custom endpoint when no test fetch is injected', async () => {
    const oneCliFetchImpl = vi.fn(async () => ({ data: [{ id: 'secured-model' }] }));
    const models = await discoverOpenCodeModels(
      provider({
        discovery_type: 'openai-compatible',
        base_url: 'https://secured.example.test/v1',
      }),
      undefined,
      oneCliFetchImpl,
    );

    expect(oneCliFetchImpl).toHaveBeenCalledWith('https://secured.example.test/v1/models');
    expect(models[0].id).toBe('openai/secured-model');
  });
});
