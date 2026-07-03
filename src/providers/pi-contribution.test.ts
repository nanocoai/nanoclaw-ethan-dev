/**
 * Behavior test for the pi HOST contribution — drives the REAL registered
 * contribution via the real barrel and registry (never by importing pi.ts's
 * internals), against a temp DATA_DIR/HOME. Same archetype as codex's
 * host-contribution test; no DB leg because pi's contribution reads none.
 *
 * Guards the mount/env shape the spawn path depends on:
 *   - `.pi-shared` per-group session dir created + mounted RW, with
 *     PI_SESSION_DIR pointing the container-side provider at it.
 *   - operator's ~/.pi/agent mounted RO only when it exists (never created).
 *   - the group's `.claude-shared/skills` symlink farm mounted RO at
 *     ~/.agents/skills (pi's always-trusted user skills source) only when it
 *     exists — NOT nested under the conditional RO ~/.pi/agent mount.
 */
import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = '/tmp/nanoclaw-pi-host-contribution-test';
const DATA_DIR = path.join(TEST_ROOT, 'data');
const HOME = path.join(TEST_ROOT, 'home');

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  DATA_DIR: '/tmp/nanoclaw-pi-host-contribution-test/data',
}));

import { getProviderContainerConfig } from './provider-container-registry.js';
import './index.js'; // the real host provider barrel

const GROUP_ID = 'ag-pi';

function runContribution() {
  const fn = getProviderContainerConfig('pi');
  expect(fn).toBeDefined();
  return fn!({
    sessionDir: path.join(DATA_DIR, 'v2-sessions', GROUP_ID, 'session-1'),
    agentGroupId: GROUP_ID,
    groupDir: path.join(TEST_ROOT, 'groups', 'pi-group'),
    selectedSkills: [],
    hostEnv: { ...process.env, HOME },
  });
}

describe('pi host contribution', () => {
  beforeEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.mkdirSync(HOME, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  });

  it('creates and mounts the per-group session dir RW and points PI_SESSION_DIR at it', () => {
    const contribution = runContribution();

    const piShared = path.join(DATA_DIR, 'v2-sessions', GROUP_ID, '.pi-shared');
    expect(fs.existsSync(piShared)).toBe(true);
    expect(contribution.mounts).toContainEqual({
      hostPath: piShared,
      containerPath: '/home/node/.pi/sessions',
      readonly: false,
    });
    expect(contribution.env).toEqual({ PI_SESSION_DIR: '/home/node/.pi/sessions' });
  });

  it('mounts the operator ~/.pi/agent config RO only when it exists, and never creates it', () => {
    const withoutConfig = runContribution();
    expect(withoutConfig.mounts?.some((m) => m.containerPath === '/home/node/.pi/agent')).toBe(false);
    expect(fs.existsSync(path.join(HOME, '.pi', 'agent'))).toBe(false);

    const hostAgentDir = path.join(HOME, '.pi', 'agent');
    fs.mkdirSync(hostAgentDir, { recursive: true });
    const withConfig = runContribution();
    expect(withConfig.mounts).toContainEqual({
      hostPath: hostAgentDir,
      containerPath: '/home/node/.pi/agent',
      readonly: true,
    });
  });

  it('mounts the group skills farm RO at ~/.agents/skills only when it exists', () => {
    const withoutSkills = runContribution();
    expect(withoutSkills.mounts?.some((m) => m.containerPath === '/home/node/.agents/skills')).toBe(false);

    const skillsDir = path.join(DATA_DIR, 'v2-sessions', GROUP_ID, '.claude-shared', 'skills');
    fs.mkdirSync(skillsDir, { recursive: true });
    const withSkills = runContribution();
    expect(withSkills.mounts).toContainEqual({
      hostPath: skillsDir,
      containerPath: '/home/node/.agents/skills',
      readonly: true,
    });
  });
});
