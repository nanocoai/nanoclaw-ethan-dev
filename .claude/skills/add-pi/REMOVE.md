# Remove the pi agent provider

Reverses every change `/add-pi` makes and returns every group to the default provider. Safe to run when partially installed — skip any step whose target is already absent.

## 1. Switch pi groups back to the default

List groups still on pi and switch each one (each group's `memory/` tree stays on disk and readable; run `/migrate-memory` per group if its memory should carry back to Claude — see [docs/provider-migration.md](../../docs/provider-migration.md)):

```bash
ncl groups list
# for each group whose config shows provider=pi:
ncl groups config update --id <group-id> --provider claude
ncl groups restart --id <group-id>
```

## 2. Delete the barrel imports

Delete (do not comment out) the `import './pi.js';` line from each of:

- `src/providers/index.ts`
- `container/agent-runner/src/providers/index.ts`

(pi has no `setup/providers/` line to remove.)

## 3. Delete every copied file

```bash
rm -f src/providers/pi.ts \
      src/providers/pi-registration.test.ts \
      src/providers/pi-contribution.test.ts \
      container/agent-runner/src/providers/pi.ts \
      container/agent-runner/src/providers/pi.test.ts \
      container/agent-runner/src/providers/pi-registration.test.ts \
      container/agent-runner/src/providers/pi-cli-tools.test.ts
```

This skill itself (`.claude/skills/add-pi/`) and `docs/pi.md` stay — both ship with trunk so the provider can be re-added later.

## 4. Remove the CLI manifest entry

Delete the `@earendil-works/pi-coding-agent` entry from `container/cli-tools.json`:

```bash
node -e '
  const fs = require("fs");
  const file = "container/cli-tools.json";
  const tools = JSON.parse(fs.readFileSync(file, "utf8")).filter((t) => t.name !== "@earendil-works/pi-coding-agent");
  const fmt = (t) => "  { " + Object.entries(t).map(([k, v]) => JSON.stringify(k) + ": " + JSON.stringify(v)).join(", ") + " }";
  fs.writeFileSync(file, "[\n" + tools.map(fmt).join(",\n") + "\n]\n");
'
```

## 5. Delete the per-group credential copies

**This step matters more for pi than for other providers.** Each group that ever ran on pi holds a real copy of the operator's pi credentials — `auth.json` seeded from the host's `~/.pi/agent` (plus any tokens pi refreshed since). Removing the provider does not remove those copies. Delete each group's pi state dir; keep it only if you expect to re-add pi and want sessions/credentials to survive:

```bash
rm -rf data/v2-sessions/<agent-group-id>/.pi-shared
```

(`.pi-shared` also holds pi's session JSONL transcripts — deleting it forfeits pi-side session resume, which is moot once the group is back on Claude.)

The host's own `~/.pi/agent` is operator property — NanoClaw never wrote to it; leave it alone.

## 6. Rebuild and verify

```bash
pnpm run build
pnpm exec tsc -p container/agent-runner/tsconfig.json --noEmit
./container/build.sh
pnpm test
cd container/agent-runner && bun test
```

All suites green and `ncl groups list` showing no pi groups means the removal is complete. Restart the service (`launchctl kickstart -k gui/$(id -u)/<label>` on macOS, `systemctl --user restart <unit>` on Linux).

Quick structural check that nothing lingers:

```bash
grep -R "pi.js" src/providers/index.ts container/agent-runner/src/providers/index.ts   # no output
grep "pi-coding-agent" container/cli-tools.json                                        # no output
```
