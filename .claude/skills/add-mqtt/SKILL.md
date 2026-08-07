---
name: add-mqtt
description: Add a generic MQTT text channel for allowlisted devices.
---

# Add MQTT channel

Adds MQTT as a first-class NanoClaw channel. Devices publish text utterances to
an external broker and receive full text replies. Audio capture, STT, TTS, and
device control stay on the device.

Read [REFERENCE.md](REFERENCE.md) for the wire protocol, broker ACL shape, and
manual device registration commands.

## Apply

### 1. Copy the adapter and tests

Fetch the `channels` branch and copy the MQTT adapter and its tests into place.
Overwrite existing copies because the registry branch is canonical.

```nc:copy from-branch:channels
src/channels/mqtt.ts
src/channels/mqtt.test.ts
src/channels/mqtt-registration.test.ts
```

### 2. Register the adapter

Append the self-registration import to the channel barrel. Skip it if the line
already exists.

```nc:append to:src/channels/index.ts
import './mqtt.js';
```

### 3. Install mqtt.js

Install the exact mqtt.js version used by the adapter.

```nc:dep
mqtt@5.15.2
```

### 4. Configure the broker

Ask for the broker URL. Use `mqtts://` when the broker offers TLS. Plain
`mqtt://` is suitable only on a trusted network.

```nc:prompt broker_url normalize:rstrip-slash validate:^mqtts?://.+
MQTT broker URL, including scheme and port, such as `mqtts://broker.example.com:8883`.
```

Ask for a stable client ID for this NanoClaw host.

```nc:prompt client_id normalize:trim validate:^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$
MQTT client ID for this NanoClaw host, such as `nanoclaw-home`.
```

Ask for the device allowlist as comma-separated lowercase IDs. Each ID must
match `[a-z0-9][a-z0-9-]{1,62}`.

```nc:prompt device_allowlist normalize:lower validate:^[a-z0-9][a-z0-9-]{1,62}(,[a-z0-9][a-z0-9-]{1,62})*$
Comma-separated MQTT device IDs, such as `pi-voice,kitchen-panel`.
```

Ask whether the broker uses username and password authentication.

```nc:prompt auth_mode normalize:lower validate:^(password|anonymous)$
Broker authentication mode: `password` or `anonymous`.
```

For password authentication, collect the username and password.

```nc:prompt broker_username normalize:trim validate:^.{1,128}$ when:auth_mode=password
MQTT broker username.
```

```nc:prompt broker_password secret validate:^.{1,}$ when:auth_mode=password
MQTT broker password.
```

Keep certificate verification enabled unless the operator explicitly uses a
private CA that is not trusted by the host yet.

```nc:prompt reject_unauthorized normalize:lower validate:^(true|false)$
Verify the MQTT broker TLS certificate? `true` is recommended; use `false` only for a temporary private-CA test.
```

Write the channel configuration to `.env`.

```nc:env-set
MQTT_ENABLED=true
MQTT_URL={{broker_url}}
MQTT_PREFIX=nanoclaw/v1
MQTT_CLIENT_ID={{client_id}}
MQTT_REJECT_UNAUTHORIZED={{reject_unauthorized}}
MQTT_DEVICE_ALLOWLIST={{device_allowlist}}
```

```nc:env-set when:auth_mode=password
MQTT_USERNAME={{broker_username}}
MQTT_PASSWORD={{broker_password}}
```

### 5. Build and test

Build first to guard the adapter's typed use of NanoClaw core and mqtt.js.

```nc:run effect:build
pnpm run build
```

Run the protocol, transport, and barrel-registration tests.

```nc:run effect:test
pnpm exec vitest run src/channels/mqtt.test.ts src/channels/mqtt-registration.test.ts
```

### 6. Restart NanoClaw

Restart the service so the adapter loads the new configuration.

```nc:run effect:restart
bash setup/lib/restart.sh
```

## Register devices

The environment allowlist is the transport boundary. NanoClaw's existing
agent-group and wiring database owns memory isolation and trigger behavior.
For every allowlisted device, follow the commands in
[REFERENCE.md](REFERENCE.md#register-a-device). Use a separate agent-group
folder when the device needs isolated memory.

## Next steps

Run the manual `mosquitto_pub` and `mosquitto_sub` check in
[REFERENCE.md](REFERENCE.md#manual-round-trip). After that works, connect the
real client. A compatible client publishes text to `in`, waits for an `out`
message with the matching `in_reply_to`, and performs local TTS if needed.

## Channel info

- **type**: `mqtt`
- **platform ID**: `mqtt:{device_id}@local`
- **threads**: no
- **payload**: UTF-8 JSON, protocol version 1
- **transport**: external MQTT broker, QoS 1 for `in` and `out`
- **default isolation**: one agent-group folder per device

## Troubleshooting

**The adapter does not start.** Confirm `MQTT_ENABLED=true`, `MQTT_URL`, and a
non-empty `MQTT_DEVICE_ALLOWLIST` in `.env`. Then check
`logs/nanoclaw.error.log` for the first MQTT error.

**The broker rejects the connection.** Check the URL scheme and port, the host
username and password, and the broker ACL. For `mqtts://`, install the private
CA on the host instead of leaving `MQTT_REJECT_UNAUTHORIZED=false`.

**A device gets `unknown_device`.** Its topic ID and payload `device_id` must be
identical and present in `MQTT_DEVICE_ALLOWLIST`. IDs are lowercase and cannot
contain underscores.

**Messages reach MQTT but no agent runs.** Pre-create the MQTT messaging group
and wire it to an agent group using the commands in `REFERENCE.md`. The adapter
does not inject into WhatsApp, Matrix, or another channel's session.

**Replies stay in NanoClaw's delivery retry path.** Confirm the broker is
connected and the device platform ID has the exact
`mqtt:{device_id}@local` form. Publish failures are deliberately thrown so the
host can retry them instead of marking a lost reply as delivered.
