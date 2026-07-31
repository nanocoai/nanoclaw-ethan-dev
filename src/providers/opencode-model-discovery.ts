import type { DiscoveredOpenCodeModel, OpenCodeModelProvider } from '../types.js';

const MODELS_DEV_URL = 'https://models.dev/api.json';
const MAX_DISCOVERY_BYTES = 8 * 1024 * 1024;

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

function positiveInteger(value: unknown): number | null {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}

function modalities(value: unknown, fallback: string): string {
  const list = Array.isArray(value) ? value : [];
  const normalized = list
    .filter((entry): entry is string => typeof entry === 'string')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  return normalized.length > 0 ? [...new Set(normalized)].join(',') : fallback;
}

async function fetchJson(url: string, authenticated: boolean, fetchImpl: FetchLike): Promise<unknown> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const response = await fetchImpl(url, {
      signal: controller.signal,
      headers: authenticated ? { Authorization: 'Bearer placeholder' } : undefined,
    });
    if (!response.ok) throw new Error(`model discovery returned HTTP ${response.status}`);
    const declaredLength = Number(response.headers.get('content-length'));
    if (Number.isFinite(declaredLength) && declaredLength > MAX_DISCOVERY_BYTES) {
      throw new Error('model discovery response is too large');
    }
    const body = await response.text();
    if (Buffer.byteLength(body, 'utf8') > MAX_DISCOVERY_BYTES) {
      throw new Error('model discovery response is too large');
    }
    return JSON.parse(body) as unknown;
  } finally {
    clearTimeout(timeout);
  }
}

function fullModelId(providerId: string, modelId: string): string {
  return `${providerId}/${modelId}`;
}

function discoverFromModelsDev(provider: OpenCodeModelProvider, payload: unknown): DiscoveredOpenCodeModel[] {
  if (typeof payload !== 'object' || payload === null) throw new Error('Models.dev returned an invalid catalog');
  const entry = (payload as Record<string, unknown>)[provider.provider_id];
  if (typeof entry !== 'object' || entry === null) {
    throw new Error(`OpenCode catalog has no provider named ${provider.provider_id}`);
  }
  const models = (entry as Record<string, unknown>).models;
  if (typeof models !== 'object' || models === null) throw new Error('OpenCode provider catalog has no models');

  return Object.entries(models as Record<string, unknown>)
    .flatMap(([catalogId, raw]) => {
      if (typeof raw !== 'object' || raw === null) return [];
      const model = raw as Record<string, unknown>;
      const id = typeof model.id === 'string' && model.id.trim() ? model.id.trim() : catalogId;
      const modelModalities = model.modalities as Record<string, unknown> | undefined;
      const outputModalities = Array.isArray(modelModalities?.output) ? modelModalities.output : ['text'];
      const contextLimit = positiveInteger((model.limit as Record<string, unknown> | undefined)?.context);
      // Exclude embedding/image-only/etc. entries that cannot run a NanoClaw text agent.
      if (!outputModalities.includes('text') || contextLimit === null) return [];
      return [
        {
          id: fullModelId(provider.provider_id, id),
          name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : id,
          contextLimit: contextLimit ?? provider.context_limit,
          outputLimit:
            positiveInteger((model.limit as Record<string, unknown> | undefined)?.output) ?? provider.output_limit,
          inputModalities: modalities(modelModalities?.input, provider.input_modalities),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function discoverFromOpenAiEndpoint(provider: OpenCodeModelProvider, payload: unknown): DiscoveredOpenCodeModel[] {
  if (typeof payload !== 'object' || payload === null || !Array.isArray((payload as Record<string, unknown>).data)) {
    throw new Error('OpenAI-compatible model discovery must return a data array');
  }
  const seen = new Set<string>();
  return ((payload as Record<string, unknown>).data as unknown[])
    .flatMap((raw) => {
      if (typeof raw !== 'object' || raw === null) return [];
      const model = raw as Record<string, unknown>;
      const rawId = typeof model.id === 'string' ? model.id.trim() : '';
      if (!rawId) return [];
      const id = fullModelId(provider.provider_id, rawId);
      if (seen.has(id)) return [];
      seen.add(id);
      const architecture = model.architecture as Record<string, unknown> | undefined;
      const topProvider = model.top_provider as Record<string, unknown> | undefined;
      return [
        {
          id,
          name: typeof model.name === 'string' && model.name.trim() ? model.name.trim() : rawId,
          contextLimit:
            positiveInteger(model.context_length) ??
            positiveInteger(model.context_window) ??
            positiveInteger(model.max_model_len) ??
            provider.context_limit,
          outputLimit:
            positiveInteger(model.max_completion_tokens) ??
            positiveInteger(topProvider?.max_completion_tokens) ??
            provider.output_limit,
          inputModalities: modalities(architecture?.input_modalities, provider.input_modalities),
        },
      ];
    })
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

function modelListUrl(provider: OpenCodeModelProvider): string {
  if (provider.models_url) return provider.models_url;
  if (!provider.base_url) throw new Error('OpenAI-compatible discovery has no base URL');
  return `${provider.base_url.replace(/\/$/, '')}/models`;
}

/** Discover selectable models without storing a NanoClaw model allowlist. */
export async function discoverOpenCodeModels(
  provider: OpenCodeModelProvider,
  fetchImpl: FetchLike = globalThis.fetch,
): Promise<DiscoveredOpenCodeModel[]> {
  const models =
    provider.discovery_type === 'openai-compatible'
      ? discoverFromOpenAiEndpoint(provider, await fetchJson(modelListUrl(provider), true, fetchImpl))
      : discoverFromModelsDev(provider, await fetchJson(MODELS_DEV_URL, false, fetchImpl));
  if (models.length === 0) throw new Error(`No text models were discovered for ${provider.name}`);
  return models;
}
