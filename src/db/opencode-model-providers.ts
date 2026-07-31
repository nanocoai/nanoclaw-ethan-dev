import type { OpenCodeModelProvider } from '../types.js';
import { getDb } from './connection.js';

export function getOpenCodeModelProvider(id: string): OpenCodeModelProvider | undefined {
  return getDb().prepare('SELECT * FROM opencode_model_providers WHERE id = ?').get(id) as
    | OpenCodeModelProvider
    | undefined;
}

export function getEnabledOpenCodeModelProvider(id: string): OpenCodeModelProvider | undefined {
  return getDb().prepare('SELECT * FROM opencode_model_providers WHERE id = ? AND enabled = 1').get(id) as
    | OpenCodeModelProvider
    | undefined;
}

export function listEnabledOpenCodeModelProviders(): OpenCodeModelProvider[] {
  return getDb()
    .prepare('SELECT * FROM opencode_model_providers WHERE enabled = 1 ORDER BY name, id')
    .all() as OpenCodeModelProvider[];
}
