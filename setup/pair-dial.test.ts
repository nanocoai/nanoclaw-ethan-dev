/**
 * The pair-dial wizard is the trusted owner-granting authority: it runs on the
 * operator's host, observes the consumed pairing, and grants owner to the paired
 * number — something the adapter's inbound handler must never do. It grants at
 * most one owner, so a second paired phone can never silently take over.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb, runMigrations } from '../src/db/index.js';
import { getOwners, hasAnyOwner } from '../src/modules/permissions/db/user-roles.js';
import { grantOwnerFromPairing } from './pair-dial.js';

beforeEach(() => {
  const db = initTestDb();
  runMigrations(db);
});

afterEach(() => {
  closeDb();
});

describe('pair-dial wizard — grants owner from the consumed pairing', () => {
  it('grants owner to the paired number with non-null provenance', () => {
    expect(hasAnyOwner()).toBe(false);

    const res = grantOwnerFromPairing('+15551239999');
    expect(res.granted).toBe(true);
    expect(res.userId).toBe('dial:+15551239999');

    const owners = getOwners();
    expect(owners).toHaveLength(1);
    expect(owners[0].user_id).toBe('dial:+15551239999');
    expect(owners[0].agent_group_id).toBeNull();
    // Provenance is the wizard, not a self-grant's null.
    expect(owners[0].granted_by).toBe('setup:pair-dial');
    expect(owners[0].granted_by).not.toBeNull();
  });

  it('does nothing when an owner already exists', () => {
    grantOwnerFromPairing('+15551239999');

    const res = grantOwnerFromPairing('+15550000000');
    expect(res.granted).toBe(false);

    const owners = getOwners();
    expect(owners).toHaveLength(1);
    expect(owners[0].user_id).toBe('dial:+15551239999'); // unchanged
  });
});
