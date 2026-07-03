/**
 * Host-side container config for the `pi` provider.
 *
 * pi (github.com/earendil-works/pi, package `@earendil-works/pi-coding-agent`)
 * is a coding-agent CLI driven over its own JSON-RPC stdio protocol — see
 * container/agent-runner/src/providers/pi.ts. It has no MCP support and no
 * native NanoClaw surfaces of its own (no composed project doc, no
 * skill-discovery links), so — unlike codex — this registration does NOT
 * declare `providesAgentSurfaces`: the default composed CLAUDE.md and skill
 * links apply, and their content reaches pi via `systemContext.instructions`
 * the same way it reaches Claude.
 *
 * Two host paths matter here:
 *
 *   - `~/.pi/agent` — pi's own config dir (models.json, auth.json): custom
 *     provider endpoints and keys. This is operator-managed, NOT written by
 *     NanoClaw (there is no OneCLI vault integration for pi's credentials —
 *     unlike codex/claude, the real keys DO reach the container here).
 *     Mounted READ-ONLY at the container user's `~/.pi/agent`, matching pi's
 *     own default `homedir()/.pi/agent` config-dir resolution. Omitted
 *     entirely if the operator hasn't set it up yet — pi will just fail its
 *     own auth resolution in that case, same as running it unconfigured
 *     outside a container.
 *
 *   - pi's session JSONL transcripts — pi keeps its own on-disk session
 *     store rather than using NanoClaw's memory scaffold for continuation.
 *     Mirroring how codex keeps `.codex-shared` and claude keeps
 *     `.claude-shared` under a per-GROUP directory that survives
 *     session/container respawns (as opposed to the per-session dir, which
 *     is torn down with the session), a `.pi-shared` dir is mounted RW and
 *     pointed to via `PI_SESSION_DIR`, the env var the container-side
 *     provider reads (falling back to `~/.pi/sessions` if unset).
 *
 *   - the group's selected skills — pi discovers Agent-Skills-standard
 *     SKILL.md dirs, and treats `~/.agents/skills/` as an always-trusted
 *     user-level source (alongside `~/.pi/agent/skills/`, which sits inside
 *     the operator config mount above). Since pi keeps the DEFAULT surfaces,
 *     the host already syncs the group's skill selection as a symlink farm
 *     at `.claude-shared/skills` (links target `/app/skills/<name>` — the
 *     unconditional shared-skills mount, so they resolve in-container).
 *     That same farm is mounted RO at `~/.agents/skills`, giving pi exactly
 *     the selection the claude provider gets. Deliberately NOT nested at
 *     `~/.pi/agent/skills`: the parent mount is read-only and conditional,
 *     so a missing `skills/` mountpoint would either fail the spawn (the
 *     macOS virtiofs limitation codex.ts documents) or force us to create
 *     directories inside the operator's own config dir.
 */
import fs from 'fs';
import os from 'os';
import path from 'path';

import { DATA_DIR } from '../config.js';
import { registerProviderContainerConfig } from './provider-container-registry.js';

const PI_SESSION_CONTAINER_DIR = '/home/node/.pi/sessions';
const PI_AGENT_CONTAINER_DIR = '/home/node/.pi/agent';
const PI_SKILLS_CONTAINER_DIR = '/home/node/.agents/skills';

registerProviderContainerConfig('pi', (ctx) => {
  // Per-group pi session state, persistent across session/container respawns.
  const piSessionDir = path.join(DATA_DIR, 'v2-sessions', ctx.agentGroupId, '.pi-shared');
  fs.mkdirSync(piSessionDir, { recursive: true });

  const mounts = [{ hostPath: piSessionDir, containerPath: PI_SESSION_CONTAINER_DIR, readonly: false }];

  // Operator-managed pi config (models.json, auth.json) — mount only if the
  // operator has actually set it up; never create it ourselves.
  const hostAgentDir = path.join(ctx.hostEnv.HOME || os.homedir(), '.pi', 'agent');
  if (fs.existsSync(hostAgentDir)) {
    mounts.push({ hostPath: hostAgentDir, containerPath: PI_AGENT_CONTAINER_DIR, readonly: true });
  }

  // Group's selected-skills symlink farm (synced by container-runner before
  // spawn — pi keeps the default surfaces), surfaced where pi's discovery
  // scans for user-level Agent Skills. Exists by contribution time: group
  // filesystem init runs first and creates it (see group-init.ts).
  const skillsDir = path.join(DATA_DIR, 'v2-sessions', ctx.agentGroupId, '.claude-shared', 'skills');
  if (fs.existsSync(skillsDir)) {
    mounts.push({ hostPath: skillsDir, containerPath: PI_SKILLS_CONTAINER_DIR, readonly: true });
  }

  return {
    mounts,
    env: { PI_SESSION_DIR: PI_SESSION_CONTAINER_DIR },
  };
});
