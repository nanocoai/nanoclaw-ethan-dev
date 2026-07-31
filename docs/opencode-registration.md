# OpenCode registration provisioning

NanoClaw can provision a new OpenCode agent group while approving an unwired messaging channel. This is creation-time configuration: it does not change the model of an existing conversation.

The approval flow is:

1. Choose **Connect new agent**.
2. Reply with the agent name.
3. Choose an OpenCode model provider.
4. Choose a model discovered from that provider.
5. Confirm creation and connection.

Only the final confirmation creates the group. NanoClaw then initializes its filesystem, sets the agent provider to `opencode`, snapshots the selected provider and model settings into the group's container configuration, creates the channel wiring, and replays the message that triggered registration.

## Model provider connections

NanoClaw stores provider connections, not a model allowlist. A connection contains:

- a display name;
- the OpenCode model-provider ID;
- a discovery type and optional API/model-list URLs;
- optional fallback context, output, and input-modality declarations for custom endpoints;
- optional initial instructions.

Connections never contain API keys. Provider credentials stay in OneCLI and are injected into matching outbound HTTP requests.

For a built-in cloud provider, model discovery reads OpenCode's live Models.dev catalog:

```bash
ncl opencode-model-providers create \
  --name "OpenAI" \
  --provider-id openai

ncl opencode-model-providers create \
  --name "OpenRouter" \
  --provider-id openrouter
```

For a local or custom OpenAI-compatible endpoint, discovery calls its real `/models` endpoint through the OneCLI network path:

```bash
ncl opencode-model-providers create \
  --name "Spark local" \
  --provider-id openai \
  --discovery-type openai-compatible \
  --base-url https://inference.example.test/v1 \
  --context-limit 65536 \
  --output-limit 8192 \
  --input-modalities text,image
```

Set `--models-url` when model discovery is not exposed at `<base-url>/models`. OpenRouter is one possible model provider rather than the cloud abstraction.

Connections are enabled by default. Set `--enabled 0` with `update` to remove one from future registration cards without affecting groups that already selected it:

```bash
ncl opencode-model-providers list
ncl opencode-model-providers update <provider-connection-id> --enabled 0
```

Cloud discovery matches OpenCode's model picker source, but it represents the provider catalog rather than account-specific entitlements. OpenAI-compatible discovery reads the endpoint's actual loaded/available model list. When more than eight models match, the Mattermost wizard asks for a name/ID search before rendering buttons.

Registration copies the selected values into `container_configs.provider_settings`. Later provider edits therefore do not silently change existing groups.

## Restart behavior

The pending name, provider, model search, selected model, and confirmation step are stored in the central database. A host restart does not lose the wizard state. NanoClaw rechecks the live model list at selection and confirmation; if the provider or model disappears, it stops the attempt and asks the operator to restart registration.
