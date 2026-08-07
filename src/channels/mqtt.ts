/**
 * MQTT channel adapter for NanoClaw v2.
 *
 * Compatible devices publish versioned text envelopes to an external broker.
 * The adapter keeps device identity separate from every other channel and
 * routes each allowlisted device through its own `mqtt:<device_id>@local`
 * messaging-group address.
 */
import { randomUUID } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { connect, type IClientOptions, type MqttClient } from 'mqtt';

import { readEnvFile } from '../env.js';
import { log } from '../log.js';
import type { ChannelAdapter, ChannelDefaults, ChannelSetup, OutboundMessage } from './adapter.js';
import { registerChannelAdapter } from './channel-registry.js';

const DEFAULT_PREFIX = 'nanoclaw/v1';
const MAX_PAYLOAD_BYTES = 64 * 1024;
const MAX_TEXT_LENGTH = 4000;
const MAX_STATUS_DETAIL_LENGTH = 512;
const MAX_PROCESSED_IDS = 1000;
const DEVICE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,62}$/;
const PLATFORM_ID_PATTERN = /^mqtt:([a-z0-9][a-z0-9-]{1,62})@local$/;

const MQTT_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'never',
};

type MqttClientLike = Pick<MqttClient, 'connected' | 'on' | 'subscribe' | 'publish' | 'end'>;
type MqttConnect = (url: string, options: IClientOptions) => MqttClientLike;

export interface MqttAdapterOptions {
  url: string;
  prefix: string;
  clientId: string;
  username?: string;
  password?: string;
  rejectUnauthorized: boolean;
  allowedDeviceIds: ReadonlySet<string>;
}

export interface MqttInboundEnvelope {
  v: 1;
  msg_id: string;
  ts: string;
  device_id: string;
  type: 'utterance';
  text: string;
  lang?: string;
  meta?: Record<string, unknown>;
}

interface MqttStatusEnvelope {
  v: 1;
  msg_id: string;
  ts: string;
  device_id: string;
  state: 'online' | 'offline' | 'listening' | 'thinking' | 'speaking' | 'error';
  detail?: string;
}

type ParseError = {
  ok: false;
  code: 'invalid_payload' | 'empty_text' | 'text_too_long' | 'device_id_mismatch';
  message: string;
};

type ParseResult<T> = { ok: true; value: T } | ParseError;

interface TopicAddress {
  deviceId: string;
  kind: 'in' | 'status';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizePrefix(prefix: string): string {
  const normalized = prefix.trim().replace(/^\/+|\/+$/g, '');
  if (!normalized || normalized.split('/').some((part) => !part || part.includes('+') || part.includes('#'))) {
    throw new Error('MQTT_PREFIX must be a non-empty topic path without wildcard segments');
  }
  return normalized;
}

function validateBrokerUrl(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    throw new Error('MQTT_URL must be a valid mqtt:// or mqtts:// URL', { cause: err });
  }
  if (parsed.protocol !== 'mqtt:' && parsed.protocol !== 'mqtts:') {
    throw new Error('MQTT_URL must use mqtt:// or mqtts://');
  }
  if (!parsed.hostname) throw new Error('MQTT_URL must include a broker hostname');
  if (parsed.username || parsed.password) {
    throw new Error('Put MQTT credentials in MQTT_USERNAME and MQTT_PASSWORD, not MQTT_URL');
  }
  return `${parsed.protocol}//${parsed.host}`;
}

export function isValidMqttDeviceId(deviceId: string): boolean {
  return DEVICE_ID_PATTERN.test(deviceId);
}

export function mqttPlatformId(deviceId: string): string {
  if (!isValidMqttDeviceId(deviceId)) {
    throw new Error(`Invalid MQTT device id: ${deviceId}`);
  }
  return `mqtt:${deviceId}@local`;
}

export function mqttDeviceIdFromPlatformId(platformId: string): string | null {
  return PLATFORM_ID_PATTERN.exec(platformId)?.[1] ?? null;
}

export function parseMqttDeviceAllowlist(raw: string): ReadonlySet<string> {
  const ids = raw
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
  if (ids.length === 0) throw new Error('MQTT_DEVICE_ALLOWLIST must contain at least one device id');
  for (const id of ids) {
    if (!isValidMqttDeviceId(id)) throw new Error(`Invalid MQTT device id in allowlist: ${id}`);
  }
  return new Set(ids);
}

function parseTopic(prefix: string, topic: string): TopicAddress | null {
  const base = `${prefix}/devices/`;
  if (!topic.startsWith(base)) return null;
  const parts = topic.slice(base.length).split('/');
  if (parts.length !== 2 || !isValidMqttDeviceId(parts[0]!)) return null;
  if (parts[1] !== 'in' && parts[1] !== 'status') return null;
  return { deviceId: parts[0]!, kind: parts[1] };
}

function parseJsonPayload(payload: Buffer): ParseResult<Record<string, unknown>> {
  if (payload.byteLength > MAX_PAYLOAD_BYTES) {
    return { ok: false, code: 'invalid_payload', message: `payload exceeds ${MAX_PAYLOAD_BYTES} bytes` };
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(payload);
  } catch (err) {
    if (!(err instanceof TypeError)) throw err;
    return { ok: false, code: 'invalid_payload', message: 'payload must be valid UTF-8 JSON' };
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!isRecord(value)) return { ok: false, code: 'invalid_payload', message: 'payload must be a JSON object' };
    return { ok: true, value };
  } catch (err) {
    if (!(err instanceof SyntaxError)) throw err;
    return { ok: false, code: 'invalid_payload', message: 'payload must be valid UTF-8 JSON' };
  }
}

function parseCommonEnvelope(
  topicDeviceId: string,
  payload: Buffer,
): ParseResult<Record<string, unknown> & { msg_id: string; ts: string; device_id: string }> {
  const parsed = parseJsonPayload(payload);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (value.v !== 1) return { ok: false, code: 'invalid_payload', message: 'v must be 1' };
  if (typeof value.msg_id !== 'string' || !value.msg_id.trim() || value.msg_id.length > 128) {
    return { ok: false, code: 'invalid_payload', message: 'msg_id must be a non-empty string up to 128 chars' };
  }
  if (typeof value.ts !== 'string' || !value.ts.endsWith('Z') || !Number.isFinite(Date.parse(value.ts))) {
    return { ok: false, code: 'invalid_payload', message: 'ts must be an ISO-8601 UTC timestamp' };
  }
  if (typeof value.device_id !== 'string' || !isValidMqttDeviceId(value.device_id)) {
    return { ok: false, code: 'invalid_payload', message: 'device_id is invalid' };
  }
  if (value.device_id !== topicDeviceId) {
    return { ok: false, code: 'device_id_mismatch', message: 'device_id must match the topic device id' };
  }
  return {
    ok: true,
    value: {
      ...value,
      msg_id: value.msg_id,
      ts: new Date(value.ts).toISOString(),
      device_id: value.device_id,
    },
  };
}

export function parseMqttInbound(topicDeviceId: string, payload: Buffer): ParseResult<MqttInboundEnvelope> {
  const common = parseCommonEnvelope(topicDeviceId, payload);
  if (!common.ok) return common;
  const value = common.value;
  if (value.type !== 'utterance') {
    return { ok: false, code: 'invalid_payload', message: 'type must be utterance' };
  }
  if (typeof value.text !== 'string' || !value.text.trim()) {
    return { ok: false, code: 'empty_text', message: 'text must not be empty' };
  }
  const text = value.text.trim();
  if (text.length > MAX_TEXT_LENGTH) {
    return { ok: false, code: 'text_too_long', message: `text exceeds ${MAX_TEXT_LENGTH} characters` };
  }
  if (value.lang !== undefined && typeof value.lang !== 'string') {
    return { ok: false, code: 'invalid_payload', message: 'lang must be a string when present' };
  }
  if (value.meta !== undefined && !isRecord(value.meta)) {
    return { ok: false, code: 'invalid_payload', message: 'meta must be an object when present' };
  }
  return {
    ok: true,
    value: {
      v: 1,
      msg_id: value.msg_id,
      ts: value.ts,
      device_id: value.device_id,
      type: 'utterance',
      text,
      ...(typeof value.lang === 'string' ? { lang: value.lang } : {}),
      ...(isRecord(value.meta) ? { meta: value.meta } : {}),
    },
  };
}

function parseMqttStatus(topicDeviceId: string, payload: Buffer): ParseResult<MqttStatusEnvelope> {
  const common = parseCommonEnvelope(topicDeviceId, payload);
  if (!common.ok) return common;
  const value = common.value;
  const states = new Set(['online', 'offline', 'listening', 'thinking', 'speaking', 'error']);
  if (typeof value.state !== 'string' || !states.has(value.state)) {
    return { ok: false, code: 'invalid_payload', message: 'state is not supported by protocol v1' };
  }
  if (value.detail !== undefined && typeof value.detail !== 'string') {
    return { ok: false, code: 'invalid_payload', message: 'detail must be a string when present' };
  }
  if (typeof value.detail === 'string' && value.detail.length > MAX_STATUS_DETAIL_LENGTH) {
    return {
      ok: false,
      code: 'invalid_payload',
      message: `detail exceeds ${MAX_STATUS_DETAIL_LENGTH} characters`,
    };
  }
  return {
    ok: true,
    value: {
      v: 1,
      msg_id: value.msg_id,
      ts: value.ts,
      device_id: value.device_id,
      state: value.state as MqttStatusEnvelope['state'],
      ...(typeof value.detail === 'string' ? { detail: value.detail } : {}),
    },
  };
}

function extractText(message: OutboundMessage): string | null {
  if (typeof message.content === 'string') return message.content.trim() || null;
  if (!isRecord(message.content)) return null;
  const text = typeof message.content.text === 'string' ? message.content.text : message.content.markdown;
  return typeof text === 'string' && text.trim() ? text.trim() : null;
}

export function createMqttAdapter(options: MqttAdapterOptions, connectClient: MqttConnect = connect): ChannelAdapter {
  const prefix = normalizePrefix(options.prefix);
  const broker = validateBrokerUrl(options.url);
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(options.clientId)) {
    throw new Error('MQTT_CLIENT_ID must be 1 to 63 letters, digits, underscores, or hyphens');
  }
  const allowedDeviceIds = new Set(options.allowedDeviceIds);
  if (allowedDeviceIds.size === 0) throw new Error('At least one MQTT device must be allowlisted');
  for (const deviceId of allowedDeviceIds) {
    if (!isValidMqttDeviceId(deviceId)) throw new Error(`Invalid MQTT device id in allowlist: ${deviceId}`);
  }

  let client: MqttClientLike | null = null;
  let channelSetup: ChannelSetup | null = null;
  let connected = false;
  const lastInboundByPlatformId = new Map<string, string>();
  const processedIds = new Set<string>();
  const processedOrder: string[] = [];
  const processingIds = new Set<string>();

  async function publish(topic: string, value: Record<string, unknown>): Promise<void> {
    if (!client?.connected || !connected) throw new Error('MQTT broker is not connected');
    await new Promise<void>((resolve, reject) => {
      client!.publish(topic, JSON.stringify(value), { qos: 1, retain: false }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async function publishError(deviceId: string, code: string, message: string, inReplyTo?: string): Promise<void> {
    if (!client?.connected || !connected || !isValidMqttDeviceId(deviceId)) return;
    await publish(`${prefix}/devices/${deviceId}/events`, {
      v: 1,
      msg_id: randomUUID(),
      ts: new Date().toISOString(),
      device_id: deviceId,
      type: 'error',
      code,
      message,
      ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
    }).catch((err: unknown) => {
      log.warn('MQTT failed to publish protocol error', { deviceId, code, err });
    });
  }

  function rememberProcessed(messageId: string): void {
    processedIds.add(messageId);
    processedOrder.push(messageId);
    while (processedOrder.length > MAX_PROCESSED_IDS) {
      const oldest = processedOrder.shift();
      if (oldest) processedIds.delete(oldest);
    }
  }

  async function handleInbound(deviceId: string, payload: Buffer): Promise<void> {
    if (!allowedDeviceIds.has(deviceId)) {
      log.warn('MQTT rejected message from unknown device', { deviceId });
      await publishError(deviceId, 'unknown_device', 'Device is not registered');
      return;
    }
    const parsed = parseMqttInbound(deviceId, payload);
    if (!parsed.ok) {
      log.warn('MQTT rejected invalid inbound payload', { deviceId, code: parsed.code, reason: parsed.message });
      await publishError(deviceId, parsed.code, parsed.message);
      return;
    }
    const envelope = parsed.value;
    if (processedIds.has(envelope.msg_id) || processingIds.has(envelope.msg_id)) {
      log.debug('MQTT ignored duplicate inbound message', { deviceId, messageId: envelope.msg_id });
      return;
    }

    const platformId = mqttPlatformId(deviceId);
    const previousInboundId = lastInboundByPlatformId.get(platformId);
    processingIds.add(envelope.msg_id);
    lastInboundByPlatformId.set(platformId, envelope.msg_id);
    try {
      await channelSetup?.onInbound(platformId, null, {
        id: envelope.msg_id,
        kind: 'chat',
        timestamp: envelope.ts,
        isGroup: false,
        content: {
          text: envelope.text,
          sender: deviceId,
          senderId: platformId,
        },
      });
      rememberProcessed(envelope.msg_id);
    } catch (err) {
      if (previousInboundId) lastInboundByPlatformId.set(platformId, previousInboundId);
      else lastInboundByPlatformId.delete(platformId);
      throw err;
    } finally {
      processingIds.delete(envelope.msg_id);
    }
  }

  async function handleStatus(deviceId: string, payload: Buffer): Promise<void> {
    if (!allowedDeviceIds.has(deviceId)) {
      log.warn('MQTT rejected status from unknown device', { deviceId });
      await publishError(deviceId, 'unknown_device', 'Device is not registered');
      return;
    }
    const parsed = parseMqttStatus(deviceId, payload);
    if (!parsed.ok) {
      log.warn('MQTT rejected invalid status payload', { deviceId, code: parsed.code, reason: parsed.message });
      await publishError(deviceId, parsed.code, parsed.message);
      return;
    }
    log.info('MQTT device status', {
      deviceId,
      state: parsed.value.state,
      detail: parsed.value.detail,
      timestamp: parsed.value.ts,
    });
  }

  async function handleMessage(topic: string, payload: Buffer): Promise<void> {
    const address = parseTopic(prefix, topic);
    if (!address) return;
    if (address.kind === 'in') await handleInbound(address.deviceId, payload);
    else await handleStatus(address.deviceId, payload);
  }

  return {
    name: 'mqtt',
    channelType: 'mqtt',
    supportsThreads: false,
    defaults: MQTT_DEFAULTS,

    async setup(setup: ChannelSetup): Promise<void> {
      channelSetup = setup;
      const mqttOptions: IClientOptions = {
        clientId: options.clientId,
        clean: true,
        reconnectPeriod: 1000,
        connectTimeout: 30_000,
        rejectUnauthorized: options.rejectUnauthorized,
        ...(options.username ? { username: options.username } : {}),
        ...(options.password ? { password: options.password } : {}),
      };
      const createdClient = connectClient(options.url, mqttOptions);
      client = createdClient;
      createdClient.on('message', (topic, payload) => {
        void handleMessage(topic, payload).catch((err) => log.error('MQTT inbound handler failed', { topic, err }));
      });
      createdClient.on('close', () => {
        connected = false;
      });

      try {
        await new Promise<void>((resolve, reject) => {
          let initial = true;
          const onConnect = () => {
            connected = true;
            createdClient.subscribe([`${prefix}/devices/+/in`, `${prefix}/devices/+/status`], { qos: 1 }, (err) => {
              if (err) {
                connected = false;
                if (initial) reject(err);
                else log.error('MQTT resubscribe failed', { err });
                initial = false;
                return;
              }
              log.info('MQTT channel connected', {
                broker,
                prefix,
                deviceCount: allowedDeviceIds.size,
              });
              if (initial) resolve();
              initial = false;
            });
          };
          createdClient.on('connect', onConnect);
          createdClient.on('error', (err) => {
            if (initial) {
              initial = false;
              reject(err);
            } else {
              log.warn('MQTT client error', { err });
            }
          });
        });
      } catch (err) {
        connected = false;
        client = null;
        channelSetup = null;
        await new Promise<void>((resolve) => createdClient.end(true, {}, () => resolve()));
        throw err;
      }

      for (const deviceId of allowedDeviceIds) {
        setup.onMetadata(mqttPlatformId(deviceId), deviceId, false);
      }
    },

    async teardown(): Promise<void> {
      if (!client) return;
      const closing = client;
      await new Promise<void>((resolve) => closing.end(false, {}, () => resolve()));
      client = null;
      channelSetup = null;
      connected = false;
    },

    isConnected(): boolean {
      return connected && client?.connected === true;
    },

    async deliver(platformId: string, _threadId: string | null, message: OutboundMessage): Promise<string | undefined> {
      const deviceId = mqttDeviceIdFromPlatformId(platformId);
      if (!deviceId || !allowedDeviceIds.has(deviceId)) {
        throw new Error(`MQTT cannot deliver to unregistered platform id: ${platformId}`);
      }
      const text = extractText(message);
      if (!text) return undefined;
      const messageId = randomUUID();
      const inReplyTo = lastInboundByPlatformId.get(platformId);
      await publish(`${prefix}/devices/${deviceId}/out`, {
        v: 1,
        msg_id: messageId,
        ts: new Date().toISOString(),
        device_id: deviceId,
        type: 'reply',
        ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
        text,
      });
      return messageId;
    },

    async setTyping(platformId: string): Promise<void> {
      const deviceId = mqttDeviceIdFromPlatformId(platformId);
      if (!deviceId || !allowedDeviceIds.has(deviceId)) return;
      const inReplyTo = lastInboundByPlatformId.get(platformId);
      await publish(`${prefix}/devices/${deviceId}/events`, {
        v: 1,
        msg_id: randomUUID(),
        ts: new Date().toISOString(),
        device_id: deviceId,
        type: 'typing',
        typing: true,
        ...(inReplyTo ? { in_reply_to: inReplyTo } : {}),
      });
    },
  };
}

registerChannelAdapter('mqtt', {
  factory: () => {
    const keys = [
      'MQTT_ENABLED',
      'MQTT_URL',
      'MQTT_USERNAME',
      'MQTT_PASSWORD',
      'MQTT_PREFIX',
      'MQTT_CLIENT_ID',
      'MQTT_REJECT_UNAUTHORIZED',
      'MQTT_DEVICE_ALLOWLIST',
    ];
    const env = readEnvFile(keys);
    const value = (key: string): string | undefined => process.env[key] || env[key];
    if (value('MQTT_ENABLED') !== 'true') return null;

    const url = value('MQTT_URL');
    const allowlist = value('MQTT_DEVICE_ALLOWLIST');
    if (!url) throw new Error('MQTT_ENABLED=true requires MQTT_URL');
    if (!allowlist) throw new Error('MQTT_ENABLED=true requires MQTT_DEVICE_ALLOWLIST');

    return createMqttAdapter({
      url,
      prefix: value('MQTT_PREFIX') || DEFAULT_PREFIX,
      clientId: value('MQTT_CLIENT_ID') || `nanoclaw-${process.pid}`,
      username: value('MQTT_USERNAME'),
      password: value('MQTT_PASSWORD'),
      rejectUnauthorized: value('MQTT_REJECT_UNAUTHORIZED') !== 'false',
      allowedDeviceIds: parseMqttDeviceAllowlist(allowlist),
    });
  },
  defaults: MQTT_DEFAULTS,
});
