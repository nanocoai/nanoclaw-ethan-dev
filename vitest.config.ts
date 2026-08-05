import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // container/agent-runner tests run under Bun (they depend on bun:sqlite).
    // See container/agent-runner/package.json "test" script.
    // container/*.test.ts: top-level only — container/agent-runner tests run
    // under Bun (they depend on bun:sqlite) and must not be picked up here.
    // These optional CLI skills keep dual-mode manifest guards: in their source
    // folders they validate the pinned payload; once copied into src/ they
    // validate the composed cli-tools.json. List them explicitly so we do not
    // run every optional skill test against an unapplied base checkout.
    include: [
      'src/**/*.test.ts',
      'setup/**/*.test.ts',
      'scripts/**/*.test.ts',
      'container/*.test.ts',
      '.claude/skills/add-gmail-tool/gmail-manifest.test.ts',
      '.claude/skills/add-gcal-tool/gcal-manifest.test.ts',
      '.claude/skills/add-opencode/opencode-manifest.test.ts',
    ],
  },
});
