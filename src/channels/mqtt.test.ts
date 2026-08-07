import { EventEmitter } from 'node:events';

import type { MqttClient } from 'mqtt';
import { describe, expect, it, vi } from 'vitest';

import type { ChannelSetup, InboundMessage } from './adapter.js';
import {
  createMqttAdapter,
  isValidMqttDeviceId,
  mqttDeviceIdFromPlatformId,
  mqttPlatformId,
  parseMqttDeviceAllowlist,
  parseMqttInbound,
} from './mqtt.js';

interface PublishedMessage {
  topic: string;
  payload: string;
  qos: number | undefined;
}

class FakeMqttClient extends EventEmitter {
  connected = false;
  ended = false;
  publishError: Error | null = null;
  subscriptions: string[][] = [];
  published: PublishedMessage[] = [];

  subscribe(topics: string | string[], options: { qos?: number }, callback: (error?: Error | null) => void): this {
    this.subscriptions.push(Array.isArray(topics) ? topics : [topics]);
    expect(options.qos).toBe(1);
    callback(null);
    return this;
  }

  publish(topic: string, payload: string, options: { qos?: number }, callback?: (error?: Error | null) => void): this {
    if (this.publishError) {
      callback?.(this.publishError);
      return this;
    }
    this.published.push({ topic, payload, qos: options.qos });
    callback?.(null);
    return this;
  }

  end(_force?: boolean, _options?: object, callback?: () => void): this {
    this.connected = false;
    this.ended = true;
    callback?.();
    return this;
  }

  connect(): void {
    this.connected = true;
    this.emit('connect');
  }

  fail(error: Error): void {
    this.emit('error', error);
  }

  receive(topic: string, payload: unknown, options: { retain?: boolean } = {}): void {
    this.emit('message', topic, Buffer.from(JSON.stringify(payload)), { retain: options.retain ?? false });
  }
}

function createHarness(
  allowedDeviceIds = new Set(['pi-voice']),
  onInboundHook?: (platformId: string, message: InboundMessage) => Promise<void>,
) {
  const client = new FakeMqttClient();
  const inbound: Array<{ platformId: string; threadId: string | null; message: InboundMessage }> = [];
  const metadata: Array<{ platformId: string; name?: string; isGroup?: boolean }> = [];
  const setup: ChannelSetup = {
    async onInbound(platformId, threadId, message) {
      inbound.push({ platformId, threadId, message });
      await onInboundHook?.(platformId, message);
    },
    async onInboundEvent() {},
    onMetadata(platformId, name, isGroup) {
      metadata.push({ platformId, name, isGroup });
    },
    onAction() {},
  };
  const adapter = createMqttAdapter(
    {
      url: 'mqtt://broker.test:1883',
      prefix: 'nanoclaw/v1',
      clientId: 'nanoclaw-test',
      rejectUnauthorized: true,
      allowedDeviceIds,
    },
    () => client as unknown as MqttClient,
  );
  return { adapter, client, inbound, metadata, setup };
}

async function startHarness(harness: ReturnType<typeof createHarness>): Promise<void> {
  const setupPromise = harness.adapter.setup(harness.setup);
  harness.client.connect();
  await setupPromise;
}

function utterance(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    v: 1,
    msg_id: '9b2f0c2e-3c1a-4b0d-9f2a-1a2b3c4d5e6f',
    ts: '2026-08-06T16:00:00.000Z',
    device_id: 'pi-voice',
    type: 'utterance',
    text: '  hello from the device  ',
    lang: 'en',
    meta: { client: 'voice-ptt' },
    ...overrides,
  };
}

describe('MQTT protocol helpers', () => {
  it('enforces device ids and stable platform ids', () => {
    expect(isValidMqttDeviceId('pi-voice')).toBe(true);
    expect(isValidMqttDeviceId('a')).toBe(false);
    expect(isValidMqttDeviceId('Pi-Voice')).toBe(false);
    expect(mqttPlatformId('pi-voice')).toBe('mqtt:pi-voice@local');
    expect(mqttDeviceIdFromPlatformId('mqtt:pi-voice@local')).toBe('pi-voice');
    expect(mqttDeviceIdFromPlatformId('whatsapp:pi-voice@local')).toBeNull();
  });

  it('parses and deduplicates a device allowlist', () => {
    expect([...parseMqttDeviceAllowlist('pi-voice, kitchen-panel,pi-voice')]).toEqual(['pi-voice', 'kitchen-panel']);
    expect(() => parseMqttDeviceAllowlist('')).toThrow(/at least one/i);
    expect(() => parseMqttDeviceAllowlist('bad_device')).toThrow(/invalid/i);
  });

  it('accepts a v1 utterance and normalizes its text', () => {
    const result = parseMqttInbound('pi-voice', Buffer.from(JSON.stringify(utterance())));
    expect(result).toEqual({
      ok: true,
      value: {
        v: 1,
        msg_id: '9b2f0c2e-3c1a-4b0d-9f2a-1a2b3c4d5e6f',
        ts: '2026-08-06T16:00:00.000Z',
        device_id: 'pi-voice',
        type: 'utterance',
        text: 'hello from the device',
        lang: 'en',
        meta: { client: 'voice-ptt' },
      },
    });
  });

  it('rejects malformed UTF-8 before JSON parsing', () => {
    const result = parseMqttInbound('pi-voice', Buffer.from([0xff, 0xfe, 0xfd]));
    expect(result).toMatchObject({ ok: false, code: 'invalid_payload' });
  });

  it.each([
    ['bad version', { v: 2 }, 'invalid_payload'],
    ['empty text', { text: '   ' }, 'empty_text'],
    ['device mismatch', { device_id: 'kitchen-panel' }, 'device_id_mismatch'],
    ['bad timestamp', { ts: 'tomorrow' }, 'invalid_payload'],
    ['wrong type', { type: 'command' }, 'invalid_payload'],
    ['oversized text', { text: 'x'.repeat(4001) }, 'text_too_long'],
  ])('rejects %s', (_label, overrides, code) => {
    const result = parseMqttInbound('pi-voice', Buffer.from(JSON.stringify(utterance(overrides))));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(code);
  });
});

describe('MQTT channel adapter', () => {
  it('connects, subscribes, reports metadata, and tears down', async () => {
    const harness = createHarness(new Set(['pi-voice', 'kitchen-panel']));
    await startHarness(harness);

    expect(harness.adapter.isConnected()).toBe(true);
    expect(harness.adapter.defaults?.mentions).toBe('never');
    expect(harness.client.subscriptions).toEqual([['nanoclaw/v1/devices/+/in', 'nanoclaw/v1/devices/+/status']]);
    expect(harness.metadata).toEqual([
      { platformId: 'mqtt:pi-voice@local', name: 'pi-voice', isGroup: false },
      { platformId: 'mqtt:kitchen-panel@local', name: 'kitchen-panel', isGroup: false },
    ]);

    await harness.adapter.teardown();
    expect(harness.adapter.isConnected()).toBe(false);
  });

  it('closes the mqtt client when initial connection fails', async () => {
    const harness = createHarness();
    const setupPromise = harness.adapter.setup(harness.setup);
    harness.client.fail(new Error('broker refused connection'));

    await expect(setupPromise).rejects.toThrow('broker refused connection');
    expect(harness.client.ended).toBe(true);
    expect(harness.adapter.isConnected()).toBe(false);
  });

  it('routes an allowlisted utterance into the host with its own identity', async () => {
    const harness = createHarness();
    await startHarness(harness);
    harness.client.receive('nanoclaw/v1/devices/pi-voice/in', utterance());

    await vi.waitFor(() => expect(harness.inbound).toHaveLength(1));
    expect(harness.inbound[0]).toEqual({
      platformId: 'mqtt:pi-voice@local',
      threadId: null,
      message: {
        id: '9b2f0c2e-3c1a-4b0d-9f2a-1a2b3c4d5e6f',
        kind: 'chat',
        timestamp: '2026-08-06T16:00:00.000Z',
        isGroup: false,
        content: {
          text: 'hello from the device',
          sender: 'pi-voice',
          senderId: 'mqtt:pi-voice@local',
        },
      },
    });
  });

  it('rejects unknown devices before they reach the host', async () => {
    const harness = createHarness();
    await startHarness(harness);
    harness.client.receive(
      'nanoclaw/v1/devices/kitchen-panel/in',
      utterance({ device_id: 'kitchen-panel', msg_id: 'unknown-1' }),
    );

    await vi.waitFor(() => expect(harness.client.published).toHaveLength(1));
    expect(harness.inbound).toHaveLength(0);
    expect(harness.client.published[0]!.topic).toBe('nanoclaw/v1/devices/kitchen-panel/events');
    expect(JSON.parse(harness.client.published[0]!.payload)).toMatchObject({
      device_id: 'kitchen-panel',
      type: 'error',
      code: 'unknown_device',
    });
  });

  it('deduplicates inbound ids and correlates replies and typing events', async () => {
    const harness = createHarness();
    await startHarness(harness);
    harness.client.receive('nanoclaw/v1/devices/pi-voice/in', utterance());
    harness.client.receive('nanoclaw/v1/devices/pi-voice/in', utterance());
    await vi.waitFor(() => expect(harness.inbound).toHaveLength(1));

    const outboundId = await harness.adapter.deliver('mqtt:pi-voice@local', null, {
      kind: 'chat',
      content: { text: 'agent reply' },
    });
    await harness.adapter.setTyping?.('mqtt:pi-voice@local', null);

    expect(outboundId).toMatch(/^[0-9a-f-]{36}$/);
    expect(harness.client.published.map((item) => item.topic)).toEqual([
      'nanoclaw/v1/devices/pi-voice/out',
      'nanoclaw/v1/devices/pi-voice/events',
    ]);
    expect(JSON.parse(harness.client.published[0]!.payload)).toMatchObject({
      v: 1,
      device_id: 'pi-voice',
      type: 'reply',
      in_reply_to: '9b2f0c2e-3c1a-4b0d-9f2a-1a2b3c4d5e6f',
      text: 'agent reply',
    });
    expect(JSON.parse(harness.client.published[1]!.payload)).toMatchObject({
      type: 'typing',
      typing: true,
      in_reply_to: '9b2f0c2e-3c1a-4b0d-9f2a-1a2b3c4d5e6f',
    });
  });

  it('scopes duplicate ids to the publishing device', async () => {
    const harness = createHarness(new Set(['pi-voice', 'kitchen-panel']));
    await startHarness(harness);
    const messageId = 'shared-device-local-id';

    harness.client.receive('nanoclaw/v1/devices/pi-voice/in', utterance({ msg_id: messageId }));
    harness.client.receive(
      'nanoclaw/v1/devices/kitchen-panel/in',
      utterance({ device_id: 'kitchen-panel', msg_id: messageId }),
    );

    await vi.waitFor(() => expect(harness.inbound).toHaveLength(2));
    expect(harness.inbound.map((item) => item.platformId)).toEqual(['mqtt:pi-voice@local', 'mqtt:kitchen-panel@local']);

    harness.client.receive('nanoclaw/v1/devices/pi-voice/in', utterance({ msg_id: messageId }));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(harness.inbound).toHaveLength(2);
  });

  it('rejects retained /in replay without poisoning the live message id', async () => {
    const harness = createHarness();
    await startHarness(harness);

    harness.client.receive('nanoclaw/v1/devices/pi-voice/in', utterance(), { retain: true });

    await vi.waitFor(() => expect(harness.client.published).toHaveLength(1));
    expect(harness.inbound).toHaveLength(0);
    expect(JSON.parse(harness.client.published[0]!.payload)).toMatchObject({
      type: 'error',
      code: 'retained_inbound',
    });

    harness.client.receive('nanoclaw/v1/devices/pi-voice/in', utterance());
    await vi.waitFor(() => expect(harness.inbound).toHaveLength(1));
  });

  it('sets reply correlation before invoking the host callback', async () => {
    const adapterRef: { current?: ReturnType<typeof createHarness>['adapter'] } = {};
    const harness = createHarness(new Set(['pi-voice']), async (platformId) => {
      if (!adapterRef.current) throw new Error('adapter not initialized');
      await adapterRef.current.deliver(platformId, null, { kind: 'chat', content: { text: 'immediate reply' } });
    });
    adapterRef.current = harness.adapter;
    await startHarness(harness);
    harness.client.receive('nanoclaw/v1/devices/pi-voice/in', utterance());

    await vi.waitFor(() => expect(harness.client.published).toHaveLength(1));
    expect(JSON.parse(harness.client.published[0]!.payload)).toMatchObject({
      type: 'reply',
      in_reply_to: '9b2f0c2e-3c1a-4b0d-9f2a-1a2b3c4d5e6f',
      text: 'immediate reply',
    });
  });

  it('uses host delivery metadata for stable ids and exact correlation', async () => {
    const harness = createHarness();
    await startHarness(harness);
    harness.client.receive('nanoclaw/v1/devices/pi-voice/in', utterance({ msg_id: 'newer-process-local-id' }));
    await vi.waitFor(() => expect(harness.inbound).toHaveLength(1));

    const outbound = {
      kind: 'chat',
      content: { text: 'agent reply' },
      deliveryId: 'session-1:out-1',
      inReplyTo: 'exact-device-message-id',
    };
    const firstId = await harness.adapter.deliver('mqtt:pi-voice@local', null, outbound);
    const retryId = await harness.adapter.deliver('mqtt:pi-voice@local', null, outbound);

    expect(firstId).toBe(retryId);
    expect(firstId).toMatch(/^nc-[0-9a-f]{64}$/);
    expect(JSON.parse(harness.client.published[0]!.payload)).toMatchObject({
      msg_id: firstId,
      in_reply_to: 'exact-device-message-id',
    });
    expect(JSON.parse(harness.client.published[1]!.payload)).toMatchObject({
      msg_id: firstId,
      in_reply_to: 'exact-device-message-id',
    });

    await harness.adapter.deliver('mqtt:pi-voice@local', null, {
      ...outbound,
      deliveryId: 'session-1:out-without-correlation',
      inReplyTo: null,
    });
    expect(JSON.parse(harness.client.published[2]!.payload)).not.toHaveProperty('in_reply_to');
  });

  it('throws outbound failures so the delivery retry path owns recovery', async () => {
    const harness = createHarness();
    await expect(
      harness.adapter.deliver('mqtt:pi-voice@local', null, { kind: 'chat', content: { text: 'reply' } }),
    ).rejects.toThrow(/not connected/i);
    await expect(
      harness.adapter.deliver('mqtt:unknown-device@local', null, { kind: 'chat', content: { text: 'reply' } }),
    ).rejects.toThrow(/unregistered/i);

    await startHarness(harness);
    harness.client.publishError = new Error('broker publish failed');
    await expect(
      harness.adapter.deliver('mqtt:pi-voice@local', null, { kind: 'chat', content: { text: 'reply' } }),
    ).rejects.toThrow('broker publish failed');
  });

  it('fails unsupported outbound payloads instead of acknowledging a send that never happened', async () => {
    const harness = createHarness();
    await startHarness(harness);

    await expect(
      harness.adapter.deliver('mqtt:pi-voice@local', null, {
        kind: 'chat',
        content: { type: 'ask_question', title: 'Choose one' },
      }),
    ).rejects.toThrow(/non-empty text/i);
    await expect(
      harness.adapter.deliver('mqtt:pi-voice@local', null, {
        kind: 'chat',
        content: { text: 'See attachment' },
        files: [{ filename: 'note.txt', data: Buffer.from('hello') }],
      }),
    ).rejects.toThrow(/file attachments/i);

    expect(harness.client.published).toHaveLength(0);
  });

  it('rejects credentials embedded in MQTT_URL', () => {
    expect(() =>
      createMqttAdapter({
        url: 'mqtt://user:secret@broker.test:1883',
        prefix: 'nanoclaw/v1',
        clientId: 'nanoclaw-test',
        rejectUnauthorized: true,
        allowedDeviceIds: new Set(['pi-voice']),
      }),
    ).toThrow(/MQTT_USERNAME/);
  });
});
