import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { MEMORY_SESSION_HOOK, memoryContextForSessionStart } from './session-hook.js';

describe('memory session hook', () => {
  it('registers the canonical in-container command and lifecycle sources', () => {
    expect(MEMORY_SESSION_HOOK.command).toBe('bun /app/src/memory/hook.ts');
    expect(MEMORY_SESSION_HOOK.sources).toEqual(['startup', 'clear', 'compact']);
  });

  it('renders memory on startup but never on resume', () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nanoclaw-hook-'));
    try {
      fs.mkdirSync(path.join(base, 'memory', 'system'), { recursive: true });
      fs.writeFileSync(path.join(base, 'memory', 'index.md'), '# Test memory\n');
      fs.writeFileSync(path.join(base, 'memory', 'system', 'definition.md'), '# Test definition\n');
      expect(memoryContextForSessionStart('startup', base)).toContain('# Test memory');
      expect(memoryContextForSessionStart('resume', base)).toBeUndefined();
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
