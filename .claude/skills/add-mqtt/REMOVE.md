# Remove MQTT channel

Every step is safe to re-run.

## 1. Remove the adapter

Delete this line from `src/channels/index.ts` if it exists:

```typescript
import './mqtt.js';
```

Delete the copied adapter and tests:

```bash
rm -f src/channels/mqtt.ts src/channels/mqtt.test.ts src/channels/mqtt-registration.test.ts
```

## 2. Remove the configuration

Remove these keys from `.env`:

```text
MQTT_ENABLED
MQTT_URL
MQTT_USERNAME
MQTT_PASSWORD
MQTT_PREFIX
MQTT_CLIENT_ID
MQTT_REJECT_UNAUTHORIZED
MQTT_DEVICE_ALLOWLIST
```

## 3. Remove mqtt.js

```bash
pnpm remove mqtt
```

## 4. Build and restart

```bash
pnpm run build
bash setup/lib/restart.sh
```

Runtime agent groups, users, messaging groups, and sessions are user data.
Review them with `ncl` and remove only the records that are no longer needed.
