# Running Agents on pi

NanoClaw agents can run on [pi](https://github.com/earendil-works/pi) (`@earendil-works/pi-coding-agent`) instead of Claude Code — a coding-agent CLI with its own model-provider abstraction, so a group can point at any endpoint pi supports (Anthropic, OpenAI, a local server, a custom gateway) without touching NanoClaw's own Anthropic-proxy path.

## Enabling It

Set the group's provider to `pi`:

```
ncl groups config update --provider pi
```

## Model Selection

pi's model setting uses `<pi-provider>/<model-id>`, split on the **first** slash — everything before it is passed as `--provider`, everything after (slashes and all) as `--model`. For example `anthropic/claude-sonnet-4/preview` becomes `--provider anthropic --model claude-sonnet-4/preview`. A value with no slash is passed through whole as `--model`. Configure it the same way you'd set a model for any other provider (`ncl groups config update --model ...`).

## Credentials and Custom Endpoints

pi does not go through NanoClaw's OneCLI credential vault. Instead, the host's own pi config directory — `~/.pi/agent` (`models.json` for custom provider/endpoint definitions, `auth.json` for keys, `settings.json`) — is bind-mounted **read-only** at a seed path (`/run/pi-agent-seed`, advertised to the container via `PI_AGENT_SEED_DIR`). Set it up once on the host by configuring `pi` normally there; NanoClaw never writes to it, only mounts it if it already exists. If it's missing, the container's pi process fails auth resolution exactly as it would running unconfigured outside a container.

It is a *seed*, not pi's live config dir, because a read-only mount at the live path fundamentally cannot work: pi wraps even auth **reads** in a file lock (`proper-lockfile` creates `auth.json.lock` next to the file), so on a read-only mount every auth read fails with EROFS and pi reports "No API key found" despite the key being present — and OAuth token refresh needs real writes regardless. On first run, the container-side provider copies `auth.json` (mode 0600), `models.json`, and `settings.json` from the seed into the writable, per-group `~/.pi/agent` (mode 0700).

The copy never overwrites: once `auth.json` exists in the per-group dir, seeding is skipped entirely, so a token pi refreshed there wins over a stale host seed. **Caveat:** each group therefore holds its own copy of the credentials, which can diverge from the host's after a token refresh (in either direction). If you rotate keys on the host, delete the group's copy (`data/v2-sessions/<agent-group-id>/.pi-shared/agent/auth.json`) to re-seed on the next container start.

## Group Context (Composed CLAUDE.md)

NanoClaw composes each group's `CLAUDE.md` at spawn as a pure `@`-include index (`@./.claude-shared.md`, `@./.claude-fragments/module-*.md`, …). Claude Code expands those imports natively; pi discovers `CLAUDE.md` as a context file but treats it as **literal text** — left alone, a pi agent sees a list of paths instead of the shared base, destination docs, and module guidance behind them (observed live as invented reply destinations).

The container-side provider therefore flattens the context itself at spawn: it recursively expands whole-line `@`-includes from the group's `CLAUDE.md` (cycle-safe; missing files tolerated with a logged placeholder), appends `CLAUDE.local.md` (the group's identity seed — pi's context discovery only knows `AGENTS.md`/`CLAUDE.md` and would never load it), and passes the result to pi as an extra `--append-system-prompt`. pi's own context-file loading is disabled with `--no-context-files` so the raw unexpanded index is never double-fed. Destination lists and module instructions reach the pi agent as real content, in the system prompt, on every spawn.

## Skills

pi agents get the same NanoClaw skills their group selects in `container.json` — the group's skill symlink farm (`data/v2-sessions/<agent-group-id>/.claude-shared/skills`, links resolving through the shared `/app/skills` mount) is mounted read-only at `~/.agents/skills`, one of pi's native Agent-Skills discovery paths (and one pi always trusts). Differences from the Claude provider:

- Discovery is model-driven: pi surfaces each skill's SKILL.md description to the model, which decides when to read it — there is no Skill-tool invocation step.
- Typed slash commands (`/whatever`) arrive as plain message text; pi does not map skills to slash commands.
- `allowed-tools` frontmatter is not enforced — pi ignores it, so a skill's tool restrictions are advisory only.

## MCP Tools Are Unavailable

pi has no MCP client. Any MCP servers configured on the group are silently ignored (the container-side provider logs a warning and drops them) — pi only has its own built-in read/edit/write/bash tools. Groups that depend on MCP-backed tooling should stay on Claude or Codex.

## Session Persistence

pi keeps its own on-disk session store rather than using NanoClaw's memory-scaffold continuation. A per-group directory (`data/v2-sessions/<agent-group-id>/.pi-shared`) is mounted read-write over the container's entire `~/.pi`, so both `sessions/` (the JSONL transcripts, pointed to via `PI_SESSION_DIR=/home/node/.pi/sessions`) and `agent/` (the seeded credential copy — see above) survive session and container respawns the same way Claude's and Codex's own state directories do. NanoClaw still scaffolds the standard `memory/` tree for the agent's own notes, since pi opts into it — pi's session JSONL is a separate, provider-owned mechanism for turn continuity.

## What Changes at the Code Level

Two files carry pi's host-side wiring:

**`src/providers/pi.ts`** — registers the `pi` container config: the `.pi-shared` RW mount over `~/.pi` + `PI_SESSION_DIR` env, the conditional read-only seed mount of the host's `~/.pi/agent` at `/run/pi-agent-seed` (+ `PI_AGENT_SEED_DIR`), and the group skills farm at `~/.agents/skills`.

**`container/cli-tools.json`** — pins `@earendil-works/pi-coding-agent` as a global CLI installed into the agent image.

## See Also

- `container/agent-runner/src/providers/pi.ts` — the container-side provider (JSON-RPC-over-stdio turn loop, event translation, context flattening)
- [pi on GitHub](https://github.com/earendil-works/pi) — upstream CLI docs
- `docs/architecture.md` — how the container spawn and mount pipeline works
