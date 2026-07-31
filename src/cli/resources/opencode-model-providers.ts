import { registerResource } from '../crud.js';

const MODALITIES = new Set(['text', 'audio', 'image', 'video', 'pdf']);

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function normalizeUrl(value: unknown, field: string): string | null {
  const text = optionalString(value);
  if (!text) return null;
  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch (error) {
    throw new Error(`${field} must be an absolute http(s) URL`, { cause: error });
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${field} must be an absolute http(s) URL`);
  }
  return parsed.toString().replace(/\/$/, '');
}

function normalizeModalities(value: unknown): string {
  const modalities = String(value ?? '')
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  for (const modality of modalities) {
    if (!MODALITIES.has(modality)) {
      throw new Error(`input_modalities contains unsupported value "${modality}"`);
    }
  }
  return [...new Set(modalities)].join(',');
}

function validateProvider(values: Record<string, unknown>): void {
  for (const key of ['name', 'provider_id'] as const) {
    const value = optionalString(values[key]);
    if (!value) throw new Error(`${key} must not be blank`);
    values[key] = value;
  }
  values.provider_id = String(values.provider_id).toLowerCase();

  const discoveryType = optionalString(values.discovery_type) ?? 'models-dev';
  if (discoveryType !== 'models-dev' && discoveryType !== 'openai-compatible') {
    throw new Error('discovery_type must be models-dev or openai-compatible');
  }
  values.discovery_type = discoveryType;
  values.base_url = normalizeUrl(values.base_url, 'base_url');
  values.models_url = normalizeUrl(values.models_url, 'models_url');
  if (discoveryType === 'openai-compatible' && !values.base_url && !values.models_url) {
    throw new Error('openai-compatible discovery requires base_url or models_url');
  }

  for (const key of ['context_limit', 'output_limit'] as const) {
    if (values[key] === undefined || values[key] === null || values[key] === '') {
      values[key] = null;
      continue;
    }
    const value = Number(values[key]);
    if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${key} must be a positive integer`);
    values[key] = value;
  }
  if (values.output_limit !== null && values.context_limit === null) {
    throw new Error('output_limit requires context_limit');
  }
  values.input_modalities = normalizeModalities(values.input_modalities);

  values.instructions = optionalString(values.instructions) ?? null;

  const enabled = Number(values.enabled ?? 1);
  if (enabled !== 0 && enabled !== 1) throw new Error('enabled must be 0 or 1');
  values.enabled = enabled;
}

registerResource({
  name: 'OpenCode model provider',
  plural: 'opencode-model-providers',
  table: 'opencode_model_providers',
  description:
    'Credential-free OpenCode provider connections. Models are discovered live from Models.dev or an OpenAI-compatible /models endpoint; credentials remain in OneCLI.',
  idColumn: 'id',
  columns: [
    { name: 'id', type: 'string', description: 'Generated provider-connection ID.', generated: true },
    {
      name: 'name',
      type: 'string',
      description: 'Human label shown during channel registration.',
      required: true,
      updatable: true,
    },
    {
      name: 'provider_id',
      type: 'string',
      description: 'OpenCode model-provider ID, such as openai, google, deepseek, or openrouter.',
      required: true,
      updatable: true,
    },
    {
      name: 'discovery_type',
      type: 'string',
      description: 'models-dev for OpenCode cloud catalog; openai-compatible for live endpoint discovery.',
      enum: ['models-dev', 'openai-compatible'],
      default: 'models-dev',
      updatable: true,
    },
    { name: 'base_url', type: 'string', description: 'Optional provider API base URL.', updatable: true },
    {
      name: 'models_url',
      type: 'string',
      description: 'Optional explicit OpenAI-compatible model-list URL.',
      updatable: true,
    },
    {
      name: 'context_limit',
      type: 'number',
      description: 'Fallback context limit for endpoint-discovered models.',
      updatable: true,
    },
    {
      name: 'output_limit',
      type: 'number',
      description: 'Fallback output limit; requires context_limit.',
      updatable: true,
    },
    {
      name: 'input_modalities',
      type: 'string',
      description: 'Fallback comma-separated text,audio,image,video,pdf capabilities for endpoint models.',
      default: '',
      updatable: true,
    },
    {
      name: 'instructions',
      type: 'string',
      description: 'Optional standing instructions staged at group creation.',
      updatable: true,
    },
    {
      name: 'enabled',
      type: 'number',
      description: '1 offers this provider during registration; 0 hides it.',
      default: 1,
      updatable: true,
    },
    { name: 'created_at', type: 'string', description: 'Auto-set.', generated: true },
    { name: 'updated_at', type: 'string', description: 'Auto-set.', generated: true },
  ],
  operations: { list: 'open', get: 'open', create: 'approval', update: 'approval', delete: 'approval' },
  naturalKey: ['name'],
  resolveDefaults: validateProvider,
  preUpdate: (updates, current) => {
    const merged = { ...current, ...updates };
    validateProvider(merged);
    for (const key of [
      'name',
      'provider_id',
      'discovery_type',
      'base_url',
      'models_url',
      'context_limit',
      'output_limit',
      'input_modalities',
      'instructions',
      'enabled',
    ]) {
      if (key in updates) updates[key] = merged[key];
    }
    updates.updated_at = new Date().toISOString();
  },
});
