/**
 * Guards MQTT's real channel-barrel integration and its mqtt.js dependency.
 * Importing the barrel must evaluate the adapter module and register `mqtt`.
 */
import { describe, expect, it } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js';

describe('mqtt channel registration', () => {
  it('registers mqtt via the channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('mqtt');
  });
});
