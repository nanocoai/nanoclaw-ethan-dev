/**
 * Dependency guard for the OpenCode CLI manifest entry.
 *
 * In this skill folder, the test validates the pinned JSON payload and checks
 * that it matches the SDK pin in the instructions. After the skill copies it
 * into src/, the same test validates the composed manifest and package.json.
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

function sourceEntry(skillText: string): CliTool | undefined {
  for (const match of skillText.matchAll(/```json\s*\n([\s\S]*?)```/g)) {
    try {
      const value = JSON.parse(match[1]) as CliTool;
      if (value.name === 'opencode-ai') return value;
    } catch {
      // Other JSON examples in the skill are unrelated to the CLI manifest.
    }
  }
  return undefined;
}

function pins(): { cli: CliTool | undefined; sdk: string | undefined } {
  const skillPath = path.join(__dirname, 'SKILL.md');
  if (fs.existsSync(skillPath)) {
    const text = fs.readFileSync(skillPath, 'utf8');
    return {
      cli: sourceEntry(text),
      sdk: text.match(/bun add @opencode-ai\/sdk@(\d+\.\d+\.\d+)/)?.[1],
    };
  }

  const root = repoRoot();
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'container', 'cli-tools.json'), 'utf8')) as CliTool[];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'container', 'agent-runner', 'package.json'), 'utf8')) as {
    dependencies?: Record<string, string>;
  };
  return {
    cli: manifest.find((tool) => tool.name === 'opencode-ai'),
    sdk: pkg.dependencies?.['@opencode-ai/sdk']?.replace(/^[^\d]*/, ''),
  };
}

describe('the OpenCode CLI manifest entry', () => {
  const { cli, sdk } = pins();

  it('is present at an exact pinned version', () => {
    expect(cli?.version).toMatch(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/);
  });

  it('matches the @opencode-ai/sdk version', () => {
    expect(cli?.version).toBe(sdk);
  });
});
