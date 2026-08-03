/**
 * Integration test for the dial channel's single reach-in: the self-registration
 * import in the `src/channels/index.ts` barrel. Importing the barrel runs dial.ts's
 * top-level `registerChannelAdapter('dial', …)`; without the import the channel is
 * silently absent.
 *
 * Behavior, not structural: it imports the real barrel and asserts the registry
 * actually contains the channel. This reflects what happens at host boot — if the
 * `import './dial.js';` line is deleted, or the barrel fails to evaluate for any
 * reason (so the channel genuinely would not register), this goes red. A structural
 * check of the import line would falsely pass in that second case.
 *
 * dial is a native adapter (no Chat SDK bridge): it uses the official `@getdial/sdk`
 * for outbound and Dial's CLI command-target (a spooled-event handler) for inbound.
 * Importing the barrel requires `@getdial/sdk` to be installed, which holds in a
 * composed install: the skill's `pnpm install` step runs before this test — so this
 * test also implicitly guards that dependency (an unmocked import throws if the
 * package is missing). Registration is a pure top-level call, and dial.ts opens the
 * spool watcher / shells out to the `dial` CLI only inside setup() (run at host
 * startup), never at import.
 */
import { describe, it, expect } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js'; // the real barrel — triggers every channel's self-registration

describe('dial channel registration', () => {
  it('registers dial via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('dial');
  });
});
