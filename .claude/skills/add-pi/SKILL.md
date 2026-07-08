---
name: add-pi
description: Use pi (@earendil-works/pi-coding-agent) as a full agent provider — pi's own model-provider abstraction reaches any endpoint pi supports (Anthropic, OpenAI, local servers, custom gateways) without touching NanoClaw's Anthropic-proxy path. Credentials are operator-managed pi config seeded from the host's ~/.pi/agent (no OneCLI vault leg). No MCP — pi has no MCP client. Per-group via `ncl groups config update --provider pi`.
---

# pi agent provider

NanoClaw selects each group's agent backend from `container_configs.provider` (default `claude`). This skill installs the [pi](https://github.com/earendil-works/pi) provider: copy the payload from the `providers` branch, append one import to each of the two provider barrels, add the pinned pi CLI to the container manifest (`container/cli-tools.json`), rebuild, restart the host.

The provider runs `pi --mode rpc` as a child process speaking JSONL over stdio: streaming events, session resume from pi's own on-disk JSONL store, steer/follow-up for mid-turn input. Model strings are `<pi-provider>/<model-id>` (split on the first slash), so one group can point at Anthropic, OpenAI, a local server, or any custom endpoint defined in pi's `models.json`.

Two things are deliberately different from codex:

- **Credentials are operator-managed, not vault-brokered.** There is no OneCLI leg and no setup picker/auth walk-through (`setup/providers/` is untouched). The host's own pi config dir (`~/.pi/agent`) is mounted read-only at a seed path and copied into a writable per-group `~/.pi/agent` on first run — the real keys DO reach the container. See **Configure credentials**.
- **No MCP.** pi has no MCP client; any MCP servers configured on the group are dropped with a logged warning. Groups that depend on MCP-backed tooling should stay on Claude or Codex.

## Install

### Pre-flight

One command tells you whether the payload is already wired (a prior apply, or a trunk that still carries it):

```bash
ls src/providers/pi.ts container/agent-runner/src/providers/pi.ts 2>/dev/null; \
grep -l "import './pi.js';" src/providers/index.ts container/agent-runner/src/providers/index.ts 2>/dev/null; \
grep -o '@earendil-works/pi-coding-agent' container/cli-tools.json 2>/dev/null
```

Five lines of output (two source files, two barrels, one manifest hit) means installed — skip to **Configure credentials**. Partial output means a partial apply; the steps below are idempotent, so continue from the top.

### Fetch and copy

```bash
git fetch origin providers
```

Copy each file with `git show origin/providers:<path> > <path>` (additive — never merge the branch):

Host (`src/providers/`):
- `pi.ts` — provider contribution: per-group `.pi-shared` state mount over `~/.pi` (+ `PI_SESSION_DIR`), conditional RO seed mount of the host's `~/.pi/agent` at `/run/pi-agent-seed` (+ `PI_AGENT_SEED_DIR`), group skills farm at `~/.agents/skills`
- `pi-registration.test.ts` — barrel-driven host registration guard
- `pi-contribution.test.ts` — drives the real registered contribution against a temp DATA_DIR/HOME and asserts the mount/env shape the spawn path depends on

Container (`container/agent-runner/src/providers/`):
- `pi.ts` — the provider (RPC turn loop, event translation, credential seed-copy, CLAUDE.md @-include flattening)
- `pi.test.ts` — provider behavior suite
- `pi-registration.test.ts` — barrel-driven container registration guard
- `pi-cli-tools.test.ts` — structural guard for the pi entry in `container/cli-tools.json`

Docs:
- `docs/pi.md` — operator-facing: model selection, credential seeding semantics, skills, session persistence

### Wire the barrels

Append `import './pi.js';` to each of:
- `src/providers/index.ts`
- `container/agent-runner/src/providers/index.ts`

(No `setup/providers/` line — pi has no setup surface; credentials are pi's own config, not vault secrets.)

### CLI manifest

The agent's global Node CLIs install from `container/cli-tools.json` (a json-merge seam), not hand-edited Dockerfile layers. Add pi by appending one entry — no native postinstall, so no `onlyBuilt`:

```bash
node -e '
  const fs = require("fs");
  const file = "container/cli-tools.json";
  const tools = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!tools.some((t) => t.name === "@earendil-works/pi-coding-agent")) {
    tools.push({ name: "@earendil-works/pi-coding-agent", version: "0.80.3" });
    const fmt = (t) => "  { " + Object.entries(t).map(([k, v]) => JSON.stringify(k) + ": " + JSON.stringify(v)).join(", ") + " }";
    fs.writeFileSync(file, "[\n" + tools.map(fmt).join(",\n") + "\n]\n");
  }
'
```

`0.80.3` is the canonical pin — the provider's RPC handling and its synthesized "No session found matching" stale-session error are verified against this release. Bump deliberately: re-run the container behavior suite after any bump.

### Build

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
```

### Restart the host

The image rebuild does not reload the **host**. pi's host contribution (`src/providers/pi.ts`) registers the `.pi-shared` state mount, the credential seed mount, and the skills-farm mount — the running host only picks them up on restart. Skip this and the first pi turn starts with no persistent state and no credentials: pi reports "No API key found" even though the host's `~/.pi/agent` is fully configured.

```bash
# macOS (launchd)
launchctl kickstart -k gui/$(id -u)/com.nanoclaw
# Linux (systemd)
systemctl --user restart nanoclaw
```

### Validate

```bash
pnpm exec vitest run src/providers/pi-registration.test.ts src/providers/pi-contribution.test.ts
cd container/agent-runner && bun test src/providers/pi-registration.test.ts src/providers/pi-cli-tools.test.ts src/providers/pi.test.ts
```

Each guards a distinct integration point — a provider is a multi-point integration:
- the host registration test goes red if the `src/providers/index.ts` barrel line is missing or the barrel fails to evaluate;
- the container registration test does the same for the container barrel;
- the cli-tools test goes red if the manifest entry is dropped or unpinned;
- the contribution test goes red if the mount/env shape drifts from what the spawn path expects.

`pi.test.ts` imports `./pi.js` directly (self-registering), so it stays green without the barrel line — it is the behavior suite, not a registration guard. Keep all of them.

## Configure credentials

pi does not go through NanoClaw's OneCLI credential vault. Configure pi **on the host, as the operator**, exactly as you would outside a container:

```bash
pi   # or: edit ~/.pi/agent/{models.json,auth.json,settings.json} directly
```

At spawn, the host mounts `~/.pi/agent` **read-only** at a seed path (`/run/pi-agent-seed`); the container-side provider copies `auth.json` (mode 0600), `models.json`, and `settings.json` into the writable per-group `~/.pi/agent` on first run. Why a seed and not a live RO mount: pi wraps even auth **reads** in `proper-lockfile` (creates `auth.json.lock` next to the file), so on a read-only mount every read fails EROFS and pi reports "No API key found" despite the key being present — and OAuth refresh needs real writes regardless. Upstream confirmed the lock-on-read is by design (it coordinates token refresh between concurrent pi instances sharing one `auth.json` — [earendil-works/pi#6406](https://github.com/earendil-works/pi/issues/6406)), so the seed-copy is the permanent mechanism, not a workaround pending a fix.

The copy never overwrites: once the per-group `auth.json` exists, seeding is skipped, so a token pi refreshed in the group's copy wins over a stale host seed. **Caveat:** each group holds its own credential copy, which can diverge from the host's after a refresh (in either direction). After rotating keys on the host, delete the group's copy to re-seed on the next container start:

```bash
rm data/v2-sessions/<agent-group-id>/.pi-shared/agent/auth.json
```

If `~/.pi/agent` doesn't exist on the host, the seed mount is simply omitted — pi fails its own auth resolution exactly as it would running unconfigured outside a container.

## Use it

Per group:

```bash
ncl groups config update --id <group-id> --provider pi
ncl groups config update --id <group-id> --model <pi-provider>/<model-id>   # e.g. anthropic/claude-sonnet-4, openai-codex/gpt-5.4
ncl groups restart --id <group-id>
```

The model string splits on the **first** slash — everything before it is pi's `--provider`, everything after (slashes and all) its `--model`. A value with no slash passes through whole as `--model`. Custom providers/endpoints come from the host's `models.json` (seeded as above).

Switching is an operator action — run it from the host. Memory does NOT carry over automatically — each provider keeps its own store; run `/migrate-memory` to carry it across. See [docs/provider-migration.md](../../docs/provider-migration.md).

What a pi group gets, and doesn't (details in [docs/pi.md](../../docs/pi.md)):

- **Group context**: the composed CLAUDE.md is flattened (@-includes expanded, `CLAUDE.local.md` appended) into `--append-system-prompt` — pi would otherwise read the include index as literal paths.
- **Skills**: the group's selected skills appear via pi's native Agent-Skills discovery at `~/.agents/skills`. Discovery is model-driven; typed `/commands` arrive as plain text; `allowed-tools` frontmatter is advisory only (pi ignores it).
- **No MCP tools** — dropped with a logged warning.
- **Sessions**: pi's own JSONL store persists in the group's `.pi-shared` dir across respawns; NanoClaw still scaffolds the `memory/` tree (pi opts in).

## Troubleshooting

- **Container dies at boot, channel silent:** `grep 'Container exited non-zero' logs/nanoclaw.error.log` — the `stderrTail` carries the reason (`Unknown provider: pi. Registered: claude` means the barrels aren't wired in the running build).
- **In-channel `Error: spawn pi ENOENT` on every message:** the image predates the manifest entry — re-run `./container/build.sh`. If it persists, the buildkit COPY cache may be stale: `docker builder prune -f && ./container/build.sh`.
- **"No API key found" despite a configured host:** the host wasn't restarted after install (seed mount not registered), the host's `~/.pi/agent` didn't exist at spawn, or the group's stale credential copy needs re-seeding (see **Configure credentials**).
- **Agent invents reply destinations / cites `@./.claude-fragments/...` paths:** the running image predates the context flattening — rebuild the image and restart the group.
- **First turn after a long idle re-answers an old message:** pi silently creates a fresh session for an unknown `--session-id`; the provider detects this via `get_state` and synthesizes the missing-session error so the runner clears the continuation. If you see repeated clears, the group's `.pi-shared/sessions` dir was likely deleted while the continuation survived in the DB.

To remove this provider, see [REMOVE.md](REMOVE.md).
