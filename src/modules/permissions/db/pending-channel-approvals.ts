/**
 * CRUD for pending_channel_approvals — the in-flight state for the
 * unknown-channel registration flow. A row exists while an owner-approval
 * card is outstanding; it's deleted on approve (after wiring is created)
 * or deny (after denied_at is set on the messaging_group).
 *
 * PRIMARY KEY on messaging_group_id gives free in-flight dedup. A second
 * mention/DM while a card is pending resolves via
 * `hasInFlightChannelApproval` in the request flow and drops silently
 * instead of spamming the owner.
 */
import { getDb } from '../../../db/connection.js';

export interface PendingChannelApproval {
  messaging_group_id: string;
  agent_group_id: string;
  original_message: string;
  approver_user_id: string;
  created_at: string;
  /** Card title shown at creation and re-used by getAskQuestionRender on click. */
  title: string;
  /** Normalized options (JSON-encoded NormalizedOption[]) — same shape persisted on pending_approvals. */
  options_json: string;
  provisioning_step:
    | 'idle'
    | 'awaiting_name'
    | 'awaiting_provider'
    | 'awaiting_model_query'
    | 'awaiting_model'
    | 'awaiting_confirmation';
  new_agent_name: string | null;
  selected_provider_id: string | null;
  selected_model_id: string | null;
}

export function createPendingChannelApproval(
  row: Pick<
    PendingChannelApproval,
    | 'messaging_group_id'
    | 'agent_group_id'
    | 'original_message'
    | 'approver_user_id'
    | 'created_at'
    | 'title'
    | 'options_json'
  >,
): void {
  getDb()
    .prepare(
      `INSERT INTO pending_channel_approvals (
         messaging_group_id, agent_group_id, original_message,
         approver_user_id, created_at, title, options_json
       )
       VALUES (
         @messaging_group_id, @agent_group_id, @original_message,
         @approver_user_id, @created_at, @title, @options_json
       )`,
    )
    .run(row);
}

export function getPendingChannelApproval(messagingGroupId: string): PendingChannelApproval | undefined {
  return getDb()
    .prepare('SELECT * FROM pending_channel_approvals WHERE messaging_group_id = ?')
    .get(messagingGroupId) as PendingChannelApproval | undefined;
}

export function hasInFlightChannelApproval(messagingGroupId: string): boolean {
  const row = getDb()
    .prepare('SELECT 1 AS x FROM pending_channel_approvals WHERE messaging_group_id = ?')
    .get(messagingGroupId) as { x: number } | undefined;
  return row !== undefined;
}

export function updatePendingChannelApprovalCard(messagingGroupId: string, title: string, optionsJson: string): void {
  getDb()
    .prepare('UPDATE pending_channel_approvals SET title = ?, options_json = ? WHERE messaging_group_id = ?')
    .run(title, optionsJson, messagingGroupId);
}

export function updatePendingChannelProvisioning(
  messagingGroupId: string,
  updates: Partial<
    Pick<PendingChannelApproval, 'provisioning_step' | 'new_agent_name' | 'selected_provider_id' | 'selected_model_id'>
  >,
): void {
  const entries = Object.entries(updates);
  if (entries.length === 0) return;
  const values: Record<string, unknown> = { messaging_group_id: messagingGroupId };
  const set = entries.map(([key, value]) => {
    values[key] = value;
    return `${key} = @${key}`;
  });
  getDb()
    .prepare(`UPDATE pending_channel_approvals SET ${set.join(', ')} WHERE messaging_group_id = @messaging_group_id`)
    .run(values);
}

/** Oldest restart-safe name or model-search prompt for this approver. */
export function getPendingTextInputForApprover(approverUserId: string): PendingChannelApproval | undefined {
  return getDb()
    .prepare(
      `SELECT * FROM pending_channel_approvals
        WHERE approver_user_id = ? AND provisioning_step IN ('awaiting_name', 'awaiting_model_query')
        ORDER BY created_at, messaging_group_id
        LIMIT 1`,
    )
    .get(approverUserId) as PendingChannelApproval | undefined;
}

export function deletePendingChannelApproval(messagingGroupId: string): void {
  getDb().prepare('DELETE FROM pending_channel_approvals WHERE messaging_group_id = ?').run(messagingGroupId);
}
