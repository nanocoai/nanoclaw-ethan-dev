import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

// Models treat prompt examples as facts about the people around them: a
// personal name anywhere in the instruction surface can resurface as a claimed
// user identity in conversation. Examples use roles ("family", "the dentist",
// "the frontend team"), never names. The list below pins names that have
// leaked before; add any newcomer here when scrubbing it.
const LEAKED_NAMES = /\b(laura|dana|bob)\b/i;

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) collectFiles(p, out);
    else if (entry.name.endsWith('.md')) out.push(p);
  }
  return out;
}

describe('prompt surfaces', () => {
  it('instruction files and memory templates contain no personal names', () => {
    const roots = [
      path.join(import.meta.dir, 'mcp-tools'),
      path.join(import.meta.dir, 'memory', 'templates'),
    ];
    const files = roots.flatMap((r) => collectFiles(r));
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const content = fs.readFileSync(file, 'utf8');
      const match = content.match(LEAKED_NAMES);
      if (match) {
        throw new Error(`${file} contains personal name "${match[0]}"`);
      }
    }
  });
});
