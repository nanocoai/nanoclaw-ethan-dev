/**
 * Dependency guard for the Google Calendar MCP CLI manifest entry.
 *
 * In this skill folder, the test validates the pinned JSON payload users apply.
 * After the skill copies it into src/, the same test validates the composed
 * project's container/cli-tools.json. This lets trunk CI cover the optional
 * skill without requiring Calendar to be baked into every base image.
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

describe('the Google Calendar MCP CLI manifest entry', () => {
  const calendar = entries().find((tool) => tool.name === '@cocal/google-calendar-mcp');

  it('is present', () => {
    expect(calendar).toBeDefined();
  });

  it('uses an exact pinned version', () => {
    expect(calendar?.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });
});
