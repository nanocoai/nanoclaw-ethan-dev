# MQTT channel reference

## Topics

The default prefix is `nanoclaw/v1`.

```text
nanoclaw/v1/devices/{device_id}/in      device to NanoClaw
nanoclaw/v1/devices/{device_id}/out     NanoClaw to device
nanoclaw/v1/devices/{device_id}/status  device lifecycle
nanoclaw/v1/devices/{device_id}/events  typing and protocol errors
```

NanoClaw subscribes to `devices/+/in` and `devices/+/status`. Devices publish
only to their own `in` and `status` topics and subscribe only to their own
`out` and `events` topics. Use broker ACLs to enforce that boundary.

## Protocol version 1

All payloads are UTF-8 JSON. The device ID must match the topic. Each inbound
message needs a unique `msg_id`, which NanoClaw uses for duplicate suppression
and reply correlation.

Device to NanoClaw:

```json
{
  "v": 1,
  "msg_id": "9b2f0c2e-3c1a-4b0d-9f2a-1a2b3c4d5e6f",
  "ts": "2026-08-06T16:00:00.000Z",
  "device_id": "pi-voice",
  "type": "utterance",
  "text": "What is on the calendar tomorrow?",
  "lang": "en",
  "meta": {
    "client": "voice-ptt",
    "client_version": "0.1.0"
  }
}
```

NanoClaw to device:

```json
{
  "v": 1,
  "msg_id": "a1a1a1a1-b2b2-c3c3-d4d4-e5e5e5e5e5e5",
  "ts": "2026-08-06T16:00:08.200Z",
  "device_id": "pi-voice",
  "type": "reply",
  "in_reply_to": "9b2f0c2e-3c1a-4b0d-9f2a-1a2b3c4d5e6f",
  "text": "You have a meeting at 10 tomorrow."
}
```

Inbound text is trimmed and limited to 4,000 characters. Payloads over 64 KiB,
unknown protocol versions, empty text, invalid timestamps, topic mismatches,
and unregistered devices are rejected before an agent run.

## Register a device

The adapter rejects any device absent from `MQTT_DEVICE_ALLOWLIST`. The host
database must also contain a messaging group and wiring for each device. The
example below gives `pi-voice` its own memory folder.

MQTT messages do not carry a platform mention signal. Until the messaging
group exists, the router ignores an allowlisted device instead of auto-creating
or attaching it to another conversation.

```bash
ncl groups create --folder voice-pi-voice --name "Voice pi-voice"
ncl messaging-groups create \
  --channel-type mqtt \
  --platform-id 'mqtt:pi-voice@local' \
  --name 'Voice pi-voice' \
  --is-group 0 \
  --unknown-sender-policy public
ncl wirings create \
  --channel-type mqtt \
  --platform-id 'mqtt:pi-voice@local' \
  --agent-group voice-pi-voice \
  --engage-mode pattern \
  --engage-pattern '.' \
  --session-mode shared \
  --sender-scope all
```

`unknown-sender-policy public` is scoped to this single MQTT conversation. The
adapter still admits only host-allowlisted device IDs, and the broker should
enforce a matching per-device ACL. Use a separate folder for every device that
needs isolated memory. Reuse an existing agent-group folder only when shared
memory is intentional.

## Manual round-trip

Subscribe to replies in one terminal:

```bash
mosquitto_sub -h <broker-host> -p 1883 -q 1 \
  -t 'nanoclaw/v1/devices/pi-voice/out'
```

Publish an utterance in another terminal. Generate a new message ID for each
attempt.

```bash
mosquitto_pub -h <broker-host> -p 1883 -q 1 \
  -t 'nanoclaw/v1/devices/pi-voice/in' \
  -m '{"v":1,"msg_id":"9b2f0c2e-3c1a-4b0d-9f2a-1a2b3c4d5e6f","ts":"2026-08-06T16:00:00.000Z","device_id":"pi-voice","type":"utterance","text":"Say hello"}'
```

The reply arrives on `out` with `in_reply_to` equal to the inbound `msg_id`.

## Status and events

A device may publish lifecycle state to `status`:

```json
{
  "v": 1,
  "msg_id": "status-01",
  "ts": "2026-08-06T16:00:00.000Z",
  "device_id": "pi-voice",
  "state": "online",
  "detail": "voice-ptt 0.1.0"
}
```

Supported states are `online`, `offline`, `listening`, `thinking`, `speaking`,
and `error`. NanoClaw publishes `typing` and protocol errors to `events`.

## Broker ACL shape

Give the NanoClaw host permission to subscribe to `devices/+/in` and
`devices/+/status`, and to publish to `devices/+/out` and `devices/+/events`.
Give each device permission only for its own topic subtree. Prefer TLS and
separate broker credentials per device.
