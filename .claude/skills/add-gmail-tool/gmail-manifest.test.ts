/**
 * Dependency guard for the Gmail MCP CLI manifest entries.
 *
 * In this skill folder, the test validates the pinned JSON payload users apply.
 * After the skill copies it into src/, the same test validates the composed
 * project's container/cli-tools.json. This lets trunk CI cover the optional
 * skill without requiring Gmail to be baked into every base image.
 */
import fs from 'fs';
import path from 'path';

import { describe, expect, it } from 'vitest';

interface CliTool {
  name: string;
  version: string;
}

function repoRoot(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'container', 'cli-tools.json'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('container/cli-tools.json not found walking up from ' + __dirname);
}

function sourceEntries(skillText: string): CliTool[] {
  return [...skillText.matchAll(/```json\s*\n([\s\S]*?)```/g)].flatMap((match) => {
    try {
      const value = JSON.parse(match[1]) as unknown;
      return typeof value === 'object' && value !== null && 'name' in value ? [value as CliTool] : [];
    } catch {
      return [];
    }
  });
}

function entries(): CliTool[] {
  const skillPath = path.join(__dirname, 'SKILL.md');
  if (fs.existsSync(skillPath)) return sourceEntries(fs.readFileSync(skillPath, 'utf8'));
  return JSON.parse(fs.readFileSync(path.join(repoRoot(), 'container', 'cli-tools.json'), 'utf8')) as CliTool[];
}

describe('the Gmail MCP CLI manifest entries', () => {
  const manifest = entries();
  const gmail = manifest.find((tool) => tool.name === '@gongrzhe/server-gmail-autoauth-mcp');
  const zodWorkaround = manifest.find((tool) => tool.name === 'zod-to-json-schema');

  it('includes the Gmail server at an exact pinned version', () => {
    expect(gmail?.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });

  it('keeps the pinned zod-to-json-schema compatibility workaround', () => {
    expect(zodWorkaround?.version).toBe('3.22.5');
  });
});
