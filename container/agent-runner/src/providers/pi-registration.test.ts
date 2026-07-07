/**
 * Integration test for the pi provider's CONTAINER-side reach-in: the self-registration
 * import in container/agent-runner/src/providers/index.ts. Importing the barrel runs
 * pi.ts's top-level registerProvider('pi', …); without that import line
 * createProvider('pi') throws 'Unknown provider' at runtime.
 *
 * Behavior, not structural, and BARREL-ONLY: it imports the real barrel (./index.js),
 * never ./pi.js directly, then asserts listProviderNames() contains the provider. The
 * existing pi.test.ts imports ./pi.js directly, so it self-registers and stays GREEN
 * when the barrel line is deleted — a unit test, not a registration guard. This goes
 * red if the barrel import is deleted/drifts or the barrel fails to evaluate. pi uses
 * the @earendil-works/pi-coding-agent CLI *binary* (not an importable package), so this
 * test does not guard that dependency — the cli-tools manifest entry is guarded by the
 * sibling pi-cli-tools.test.ts plus the container build (see the skill validate step).
 */
import { describe, it, expect } from 'bun:test';

import { listProviderNames } from './provider-registry.js';
import './index.js'; // the real container provider barrel — triggers each provider's registerProvider()

describe('pi provider registration', () => {
  it('registers pi via the provider barrel', () => {
    expect(listProviderNames()).toContain('pi');
  });
});
