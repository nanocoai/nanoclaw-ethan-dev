# NanoClaw

NanoClaw connects messaging conversations to persistent agent groups and provisions the runtime each group uses.

## Language

**Agent provider**:
The agent runtime integration NanoClaw starts for a group, such as OpenCode.
_Avoid_: Harness, backend

**Model provider**:
The service OpenCode uses to run a model, such as OpenAI, Google, DeepSeek, OpenRouter, or a local OpenAI-compatible endpoint.
_Avoid_: Agent provider, cloud provider

**Model**:
A model identifier understood by one model provider.
_Avoid_: Provider, backend

**Model provider connection**:
A named OpenCode model-provider configuration whose available models are discovered when an agent group is registered. It may represent a cloud provider or a local compatible endpoint and never contains credentials.
_Avoid_: Model profile, preset, provider

**Channel registration**:
The owner-approved process that connects an unwired messaging conversation to an existing or newly provisioned agent group.
_Avoid_: Pairing, model switching
