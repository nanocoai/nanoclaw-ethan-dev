import { describe, expect, it } from 'vitest';

import { applyOpenCodeProviderSettings } from './opencode.js';

describe('OpenCode provisioned provider settings', () => {
  it('overrides inherited service defaults for a configured model provider', () => {
    const env = {
      OPENCODE_PROVIDER: 'openai',
      ANTHROPIC_BASE_URL: 'http://local-vllm.example/v1',
      OPENCODE_SMALL_MODEL: 'openai/local-small',
      OPENCODE_MODEL_CONTEXT_LIMIT: '65536',
      OPENCODE_MODEL_OUTPUT_LIMIT: '8192',
      OPENCODE_MODEL_INPUT_MODALITIES: 'text,image',
    };

    applyOpenCodeProviderSettings(env, {
      modelProvider: 'google',
      baseUrl: null,
      smallModel: 'google/gemini-2.5-flash',
      contextLimit: 1_048_576,
      outputLimit: 65_536,
      inputModalities: 'text,image,pdf',
    });

    expect(env).toEqual({
      OPENCODE_PROVIDER: 'google',
      OPENCODE_SMALL_MODEL: 'google/gemini-2.5-flash',
      OPENCODE_MODEL_CONTEXT_LIMIT: '1048576',
      OPENCODE_MODEL_OUTPUT_LIMIT: '65536',
      OPENCODE_MODEL_INPUT_MODALITIES: 'text,image,pdf',
    });
  });

  it('clears invalid hand-edited values instead of leaking local defaults', () => {
    const env: Record<string, string> = {
      ANTHROPIC_BASE_URL: 'http://local-vllm.example/v1',
      OPENCODE_MODEL_CONTEXT_LIMIT: '65536',
    };

    applyOpenCodeProviderSettings(env, {
      baseUrl: '',
      contextLimit: -1,
    });

    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();
    expect(env.OPENCODE_MODEL_CONTEXT_LIMIT).toBeUndefined();
  });
});
