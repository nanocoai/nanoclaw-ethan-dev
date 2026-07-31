/**
 * Permissions module — sender resolution + access gate.
 *
 * Registers two hooks into the core router:
 *   1. setSenderResolver — runs before agent resolution. Parses the payload,
 *      derives a namespaced user id, and upserts the `users` row on first
 *      sight. Returns null when the payload doesn't carry enough to identify
 *      a sender.
 *   2. setAccessGate — runs after agent resolution. Enforces the
 *      unknown_sender_policy (strict/request_approval/public) and the
 *      owner/global-admin/scoped-admin/member access hierarchy. Records its
 *      own `dropped_messages` row on refusal (structural drops are recorded
 *      by core).
 *
 * Without this module: sender resolution is a no-op (userId=null); the
 * access gate is not registered and core defaults to allow-all.
 */
import { recordDroppedMessage } from '../../db/dropped-messages.js';
import { normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { getAgentGroup, getAllAgentGroups } from '../../db/agent-groups.js';
import {
  getEnabledOpenCodeModelProvider,
  listEnabledOpenCodeModelProviders,
} from '../../db/opencode-model-providers.js';
import { createMessagingGroupAgent, setMessagingGroupDeniedAt } from '../../db/messaging-groups.js';
import {
  routeInbound,
  setAccessGate,
  setChannelRequestGate,
  registerMessageInterceptor,
  setSenderResolver,
  setSenderScopeGate,
  type AccessGateResult,
} from '../../router.js';
import type { InboundEvent } from '../../channels/adapter.js';
import { registerResponseHandler, type ResponsePayload } from '../../response-registry.js';
import { getDeliveryAdapter } from '../../delivery.js';
import { log } from '../../log.js';
import { discoverOpenCodeModels } from '../../providers/opencode-model-discovery.js';
import type {
  AgentGroup,
  DiscoveredOpenCodeModel,
  MessagingGroup,
  MessagingGroupAgent,
  OpenCodeModelProvider,
} from '../../types.js';
import { canAccessAgentGroup } from './access.js';
import {
  buildAgentSelectionOptions,
  CHOOSE_EXISTING_VALUE,
  CONNECT_PREFIX,
  createNewAgentGroup,
  NEW_AGENT_VALUE,
  REJECT_VALUE,
  requestChannelApproval,
} from './channel-approval.js';
import { addMember } from './db/agent-group-members.js';
import {
  deletePendingChannelApproval,
  getPendingTextInputForApprover,
  getPendingChannelApproval,
  updatePendingChannelApprovalCard,
  updatePendingChannelProvisioning,
  type PendingChannelApproval,
} from './db/pending-channel-approvals.js';
import { deletePendingSenderApproval, getPendingSenderApproval } from './db/pending-sender-approvals.js';
import { hasAdminPrivilege } from './db/user-roles.js';
import { getUser, upsertUser } from './db/users.js';
import { requestSenderApproval } from './sender-approval.js';
import { ensureUserDm } from './user-dm.js';

const OPENCODE_PROVIDER_PREFIX = 'opencode_provider:';
const OPENCODE_MODEL_PREFIX = 'opencode_model:';
const CONFIRM_NEW_AGENT_VALUE = 'confirm_new_agent';
const CANCEL_NEW_AGENT_VALUE = 'cancel_new_agent';
const MODEL_OPTION_LIMIT = 8;

function extractAndUpsertUser(event: InboundEvent): string | null {
  let content: Record<string, unknown>;
  try {
    content = JSON.parse(event.message.content) as Record<string, unknown>;
  } catch {
    return null;
  }

  // chat-sdk-bridge serializes author info as a nested `author.userId` and
  // does NOT populate top-level `senderId`. Older adapters (v1, native) put
  // `senderId` or `sender` directly at the top level. Check all three.
  const senderIdField = typeof content.senderId === 'string' ? content.senderId : undefined;
  const senderField = typeof content.sender === 'string' ? content.sender : undefined;
  const author =
    typeof content.author === 'object' && content.author !== null
      ? (content.author as Record<string, unknown>)
      : undefined;
  const authorUserId = typeof author?.userId === 'string' ? (author.userId as string) : undefined;
  const senderName =
    (typeof content.senderName === 'string' ? content.senderName : undefined) ??
    (typeof author?.fullName === 'string' ? (author.fullName as string) : undefined) ??
    (typeof author?.userName === 'string' ? (author.userName as string) : undefined);

  const rawHandle = senderIdField ?? senderField ?? authorUserId;
  if (!rawHandle) return null;

  const userId = rawHandle.includes(':') ? rawHandle : `${event.channelType}:${rawHandle}`;
  if (!getUser(userId)) {
    upsertUser({
      id: userId,
      kind: event.channelType,
      display_name: senderName ?? null,
      created_at: new Date().toISOString(),
    });
  }
  return userId;
}

function safeParseContent(raw: string): { text?: string; sender?: string; senderId?: string } {
  try {
    return JSON.parse(raw);
  } catch {
    return { text: raw };
  }
}

function handleUnknownSender(
  mg: MessagingGroup,
  userId: string | null,
  agentGroupId: string,
  accessReason: string,
  event: InboundEvent,
): void {
  const parsed = safeParseContent(event.message.content);
  const senderName = parsed.sender ?? null;
  const dropRecord = {
    channel_type: event.channelType,
    platform_id: event.platformId,
    user_id: userId,
    sender_name: senderName,
    reason: `unknown_sender_${mg.unknown_sender_policy}`,
    messaging_group_id: mg.id,
    agent_group_id: agentGroupId,
  };

  if (mg.unknown_sender_policy === 'strict') {
    log.info('MESSAGE DROPPED — unknown sender (strict policy)', {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      accessReason,
    });
    recordDroppedMessage(dropRecord);
    return;
  }

  if (mg.unknown_sender_policy === 'request_approval') {
    log.info('MESSAGE DROPPED — unknown sender (approval requested)', {
      messagingGroupId: mg.id,
      agentGroupId,
      userId,
      accessReason,
    });
    recordDroppedMessage(dropRecord);
    // Fire-and-forget; pick-approver + delivery + row-insert are all async.
    // If it fails it logs internally — the user's message still stays dropped
    // either way. Requires a resolved userId (senderResolver populates users
    // row before the gate fires); if we got here without one, there's nothing
    // to identify for approval and we just stay in the "silent strict" branch.
    if (userId) {
      requestSenderApproval({
        messagingGroupId: mg.id,
        agentGroupId,
        senderIdentity: userId,
        senderName,
        event,
      }).catch((err) => log.error('Sender-approval flow threw', { err }));
    }
    return;
  }

  // 'public' should have been handled before the gate; fall through silently.
}

setSenderResolver(extractAndUpsertUser);

setAccessGate((event, userId, mg, agentGroupId): AccessGateResult => {
  // Public channels skip the access check entirely.
  if (mg.unknown_sender_policy === 'public') {
    return { allowed: true };
  }

  if (!userId) {
    handleUnknownSender(mg, null, agentGroupId, 'unknown_user', event);
    return { allowed: false, reason: 'unknown_user' };
  }

  const decision = canAccessAgentGroup(userId, agentGroupId);
  if (decision.allowed) {
    return { allowed: true };
  }

  handleUnknownSender(mg, userId, agentGroupId, decision.reason, event);
  return { allowed: false, reason: decision.reason };
});

/**
 * Per-wiring sender-scope enforcement. Stricter than the messaging-group
 * `unknown_sender_policy` — a wiring can require `sender_scope='known'`
 * (explicit owner / admin / member) even on a 'public' messaging group.
 *
 * 'all' is a no-op; any sender passes. 'known' requires a userId that
 * canAccessAgentGroup accepts (owner, admin, or group member).
 */
setSenderScopeGate(
  (_event: InboundEvent, userId: string | null, _mg: MessagingGroup, agent: MessagingGroupAgent): AccessGateResult => {
    if (agent.sender_scope === 'all') return { allowed: true };
    if (!userId) return { allowed: false, reason: 'unknown_user_scope' };
    const decision = canAccessAgentGroup(userId, agent.agent_group_id);
    if (decision.allowed) return { allowed: true };
    return { allowed: false, reason: `sender_scope_${decision.reason}` };
  },
);

/**
 * Response handler for the unknown-sender approval card.
 *
 * Claim rule: questionId matches a row in pending_sender_approvals. If no
 * such row, return false so the next handler (approvals module, OneCLI,
 * interactive) gets a shot.
 *
 * Approve: add the sender to agent_group_members + re-invoke routeInbound
 * with the stored event. The second routing attempt clears the gate because
 * the user is now a member.
 *
 * Deny: delete the row (no "deny list" — a future message re-triggers a
 * fresh card per ACTION-ITEMS item 5 "no denial persistence").
 */
async function handleSenderApprovalResponse(payload: ResponsePayload): Promise<boolean> {
  const row = getPendingSenderApproval(payload.questionId);
  if (!row) return false;

  // payload.userId is the raw platform userId (e.g. "6037840640"); namespace it
  // with the channel type so it matches users(id) format. Some platforms
  // (e.g. Teams "29:xxx") already include a colon — mirror resolveOrCreateUser
  // logic and only prefix when the raw id has no colon.
  const clickerId = payload.userId
    ? payload.userId.includes(':')
      ? payload.userId
      : `${payload.channelType}:${payload.userId}`
    : null;
  const isAuthorized =
    clickerId !== null && (clickerId === row.approver_user_id || hasAdminPrivilege(clickerId, row.agent_group_id));
  if (!isAuthorized) {
    log.warn('Unknown-sender approval click rejected — unauthorized clicker', {
      approvalId: row.id,
      clickerId,
      expectedApprover: row.approver_user_id,
    });
    return true; // claim the response so it's not unclaimed-logged, but do nothing
  }
  const approverId = clickerId;
  const approved = payload.value === 'approve';

  if (approved) {
    addMember({
      user_id: row.sender_identity,
      agent_group_id: row.agent_group_id,
      added_by: approverId,
      added_at: new Date().toISOString(),
    });
    log.info('Unknown sender approved — member added', {
      approvalId: row.id,
      senderIdentity: row.sender_identity,
      agentGroupId: row.agent_group_id,
      approverId,
    });

    // Clear the pending row BEFORE re-routing so the gate check on the
    // second attempt doesn't see the in-flight row and short-circuit.
    deletePendingSenderApproval(row.id);

    try {
      const event = JSON.parse(row.original_message) as InboundEvent;
      await routeInbound(event);
    } catch (err) {
      log.error('Failed to replay message after sender approval', { approvalId: row.id, err });
    }
    return true;
  }

  log.info('Unknown sender denied', {
    approvalId: row.id,
    senderIdentity: row.sender_identity,
    agentGroupId: row.agent_group_id,
    approverId,
  });
  deletePendingSenderApproval(row.id);
  return true;
}

registerResponseHandler(handleSenderApprovalResponse);

// ── Unknown-channel registration flow ──

setChannelRequestGate(async (mg, event) => {
  await requestChannelApproval({ messagingGroupId: mg.id, event });
});

async function deliverRegistrationQuestion(
  row: PendingChannelApproval,
  title: string,
  question: string,
  rawOptions: RawOption[],
): Promise<boolean> {
  const approverDm = await ensureUserDm(row.approver_user_id);
  const adapter = getDeliveryAdapter();
  if (!approverDm || !adapter) {
    log.error('Channel registration: cannot deliver provisioning question', {
      messagingGroupId: row.messaging_group_id,
      approverUserId: row.approver_user_id,
      hasDm: !!approverDm,
      hasAdapter: !!adapter,
    });
    return false;
  }
  const options = normalizeOptions(rawOptions);
  updatePendingChannelApprovalCard(row.messaging_group_id, title, JSON.stringify(options));
  try {
    await adapter.deliver(
      approverDm.channel_type,
      approverDm.platform_id,
      null,
      'chat-sdk',
      JSON.stringify({
        type: 'ask_question',
        questionId: row.messaging_group_id,
        title,
        question,
        options,
      }),
    );
    return true;
  } catch (err) {
    log.error('Channel registration: provisioning question delivery failed', {
      messagingGroupId: row.messaging_group_id,
      title,
      err,
    });
    return false;
  }
}

async function deliverRegistrationText(row: PendingChannelApproval, text: string): Promise<void> {
  const approverDm = await ensureUserDm(row.approver_user_id);
  const adapter = getDeliveryAdapter();
  if (!approverDm || !adapter) return;
  try {
    await adapter.deliver(approverDm.channel_type, approverDm.platform_id, null, 'chat-sdk', JSON.stringify({ text }));
  } catch (err) {
    log.error('Channel registration: provisioning status delivery failed', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
  }
}

function filterDiscoveredModels(models: DiscoveredOpenCodeModel[], query: string): DiscoveredOpenCodeModel[] {
  const needle = query.trim().toLowerCase();
  return models.filter((model) => model.id.toLowerCase().includes(needle) || model.name.toLowerCase().includes(needle));
}

async function loadDiscoveredModels(
  row: PendingChannelApproval,
  provider: OpenCodeModelProvider,
): Promise<DiscoveredOpenCodeModel[] | null> {
  try {
    return await discoverOpenCodeModels(provider);
  } catch (err) {
    log.error('Channel registration: OpenCode model discovery failed', {
      messagingGroupId: row.messaging_group_id,
      modelProviderId: provider.id,
      openCodeProviderId: provider.provider_id,
      err,
    });
    await deliverRegistrationText(
      row,
      `Could not read models from ${provider.name}. Check the provider connection and OneCLI rule, then mention the bot again.`,
    );
    deletePendingChannelApproval(row.messaging_group_id);
    return null;
  }
}

async function offerDiscoveredModels(
  row: PendingChannelApproval,
  provider: OpenCodeModelProvider,
  models: DiscoveredOpenCodeModel[],
): Promise<void> {
  if (models.length > MODEL_OPTION_LIMIT) {
    updatePendingChannelProvisioning(row.messaging_group_id, {
      provisioning_step: 'awaiting_model_query',
      selected_provider_id: provider.id,
      selected_model_id: null,
    });
    await deliverRegistrationText(
      row,
      `${provider.name} has ${models.length} available models. Reply with part of the model name or ID to search.`,
    );
    return;
  }

  updatePendingChannelProvisioning(row.messaging_group_id, {
    provisioning_step: 'awaiting_model',
    selected_provider_id: provider.id,
    selected_model_id: null,
  });
  const delivered = await deliverRegistrationQuestion(
    row,
    '🧠 Choose an OpenCode model',
    `Which ${provider.name} model should "${row.new_agent_name}" use?`,
    [
      ...models.map((model) => ({
        label: model.name,
        selectedLabel: `✅ ${model.name}`,
        value: `${OPENCODE_MODEL_PREFIX}${encodeURIComponent(model.id)}`,
      })),
      { label: 'Cancel', selectedLabel: '🙅 Cancelled', value: CANCEL_NEW_AGENT_VALUE },
    ],
  );
  if (!delivered) deletePendingChannelApproval(row.messaging_group_id);
}

async function wireApprovedChannel(
  row: PendingChannelApproval,
  targetAgentGroupId: string,
  approverId: string,
): Promise<boolean> {
  let event: InboundEvent;
  try {
    event = JSON.parse(row.original_message) as InboundEvent;
  } catch (err) {
    log.error('Channel registration: failed to parse stored event', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    deletePendingChannelApproval(row.messaging_group_id);
    return false;
  }

  const isGroup = event.threadId !== null;
  const engageMode: MessagingGroupAgent['engage_mode'] = isGroup ? 'mention-sticky' : 'pattern';
  const engagePattern = isGroup ? null : '.';
  const mgaId = `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  try {
    createMessagingGroupAgent({
      id: mgaId,
      messaging_group_id: row.messaging_group_id,
      agent_group_id: targetAgentGroupId,
      engage_mode: engageMode,
      engage_pattern: engagePattern,
      sender_scope: 'known',
      ignored_message_policy: 'accumulate',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
  } catch (err) {
    log.error('Channel registration: failed to create wiring', {
      messagingGroupId: row.messaging_group_id,
      targetAgentGroupId,
      err,
    });
    return false;
  }

  log.info('Channel registration approved — wiring created', {
    messagingGroupId: row.messaging_group_id,
    agentGroupId: targetAgentGroupId,
    mgaId,
    engageMode,
    approverId,
  });

  const senderUserId = extractAndUpsertUser(event);
  if (senderUserId) {
    addMember({
      user_id: senderUserId,
      agent_group_id: targetAgentGroupId,
      added_by: approverId,
      added_at: new Date().toISOString(),
    });
  }

  deletePendingChannelApproval(row.messaging_group_id);
  try {
    await routeInbound(event);
  } catch (err) {
    log.error('Failed to replay message after channel approval', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
  }
  return true;
}

/**
 * Response handler for the unknown-channel registration card.
 *
 * Claim rule: questionId matches a pending_channel_approvals row (keyed
 * by messaging_group_id). If no such row, return false so downstream
 * handlers get a shot.
 *
 * Value dispatch:
 *   connect:<id>    — wire to an existing agent group, replay the message
 *   choose_existing — send a follow-up card listing all agents
 *   new_agent       — begin the OpenCode provisioning wizard
 *   opencode_provider:<id> — choose a configured model-provider connection
 *   opencode_model:<id>    — choose a model discovered from that provider
 *   confirm_new_agent      — provision, wire, and replay
 *   cancel_new_agent       — abandon provisioning without denying channel
 *   reject          — set denied_at, delete pending row
 */
async function handleChannelApprovalResponse(payload: ResponsePayload): Promise<boolean> {
  const row = getPendingChannelApproval(payload.questionId);
  if (!row) return false;

  const clickerId = payload.userId
    ? payload.userId.includes(':')
      ? payload.userId
      : `${payload.channelType}:${payload.userId}`
    : null;
  const isAuthorized =
    clickerId !== null && (clickerId === row.approver_user_id || hasAdminPrivilege(clickerId, row.agent_group_id));
  if (!isAuthorized) {
    log.warn('Channel registration click rejected — unauthorized clicker', {
      messagingGroupId: row.messaging_group_id,
      clickerId,
      expectedApprover: row.approver_user_id,
    });
    return true;
  }
  const approverId = clickerId;

  // ── Reject / Cancel ──
  if (payload.value === REJECT_VALUE) {
    setMessagingGroupDeniedAt(row.messaging_group_id, new Date().toISOString());
    deletePendingChannelApproval(row.messaging_group_id);
    log.info('Channel registration denied', {
      messagingGroupId: row.messaging_group_id,
      approverId,
    });
    return true;
  }

  // ── Choose existing agent — send agent-selection follow-up card ──
  if (payload.value === CHOOSE_EXISTING_VALUE) {
    if (row.provisioning_step !== 'idle') return true;
    const approverDm = await ensureUserDm(row.approver_user_id);
    if (!approverDm) {
      log.error('Channel registration: no DM channel for approver', {
        messagingGroupId: row.messaging_group_id,
        approverUserId: row.approver_user_id,
      });
      return true;
    }

    const adapter = getDeliveryAdapter();
    if (!adapter) return true;

    const agentGroups = getAllAgentGroups();
    const options = buildAgentSelectionOptions(agentGroups, approverId);
    const title = '📋 Choose an agent';
    updatePendingChannelApprovalCard(row.messaging_group_id, title, JSON.stringify(options));

    try {
      await adapter.deliver(
        approverDm.channel_type,
        approverDm.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({
          type: 'ask_question',
          questionId: row.messaging_group_id,
          title,
          question: 'Which agent should handle this channel?',
          options,
        }),
      );
    } catch (err) {
      log.error('Channel registration: agent-selection card delivery failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
    }
    return true;
  }

  // ── Create new agent — prompt for free-text name ──
  if (payload.value === NEW_AGENT_VALUE) {
    if (row.provisioning_step !== 'idle') {
      log.warn('Channel registration: stale new-agent click ignored', {
        messagingGroupId: row.messaging_group_id,
        step: row.provisioning_step,
      });
      return true;
    }
    const approverDm = await ensureUserDm(row.approver_user_id);
    if (!approverDm) {
      log.error('Channel registration: no DM channel for approver', {
        messagingGroupId: row.messaging_group_id,
        approverUserId: row.approver_user_id,
      });
      return true;
    }

    const adapter = getDeliveryAdapter();
    if (!adapter) {
      log.error('Channel registration: no delivery adapter for name prompt', {
        messagingGroupId: row.messaging_group_id,
      });
      return true;
    }

    updatePendingChannelProvisioning(row.messaging_group_id, {
      provisioning_step: 'awaiting_name',
      new_agent_name: null,
      selected_provider_id: null,
      selected_model_id: null,
    });

    try {
      await adapter.deliver(
        approverDm.channel_type,
        approverDm.platform_id,
        null,
        'chat-sdk',
        JSON.stringify({ text: 'Reply with the name for your new agent:' }),
      );
    } catch (err) {
      log.error('Channel registration: name prompt delivery failed', {
        messagingGroupId: row.messaging_group_id,
        err,
      });
      updatePendingChannelProvisioning(row.messaging_group_id, { provisioning_step: 'idle' });
    }
    return true;
  }

  // ── OpenCode model provider ──
  if (payload.value.startsWith(OPENCODE_PROVIDER_PREFIX)) {
    if (row.provisioning_step !== 'awaiting_provider' || !row.new_agent_name) {
      log.warn('Channel registration: stale OpenCode provider click ignored', {
        messagingGroupId: row.messaging_group_id,
        step: row.provisioning_step,
      });
      return true;
    }
    let providerId: string;
    try {
      providerId = decodeURIComponent(payload.value.slice(OPENCODE_PROVIDER_PREFIX.length));
    } catch {
      log.warn('Channel registration: malformed OpenCode provider response ignored', {
        messagingGroupId: row.messaging_group_id,
      });
      return true;
    }
    const modelProvider = getEnabledOpenCodeModelProvider(providerId);
    if (!modelProvider) {
      await deliverRegistrationText(row, 'That OpenCode provider is no longer available. Start again.');
      deletePendingChannelApproval(row.messaging_group_id);
      return true;
    }
    const models = await loadDiscoveredModels(row, modelProvider);
    if (models) await offerDiscoveredModels(row, modelProvider, models);
    return true;
  }

  // ── Discovered OpenCode model ──
  if (payload.value.startsWith(OPENCODE_MODEL_PREFIX)) {
    if (row.provisioning_step !== 'awaiting_model' || !row.new_agent_name || !row.selected_provider_id) {
      log.warn('Channel registration: stale OpenCode model click ignored', {
        messagingGroupId: row.messaging_group_id,
        step: row.provisioning_step,
      });
      return true;
    }
    let modelId: string;
    try {
      modelId = decodeURIComponent(payload.value.slice(OPENCODE_MODEL_PREFIX.length));
    } catch {
      log.warn('Channel registration: malformed OpenCode model response ignored', {
        messagingGroupId: row.messaging_group_id,
      });
      return true;
    }
    const modelProvider = getEnabledOpenCodeModelProvider(row.selected_provider_id);
    if (!modelProvider) {
      await deliverRegistrationText(row, 'That OpenCode provider is no longer available. Start again.');
      deletePendingChannelApproval(row.messaging_group_id);
      return true;
    }
    const models = await loadDiscoveredModels(row, modelProvider);
    if (!models) return true;
    const model = models.find((candidate) => candidate.id === modelId);
    if (!model) {
      await deliverRegistrationText(row, 'That model is no longer available from the provider. Start again.');
      deletePendingChannelApproval(row.messaging_group_id);
      return true;
    }
    updatePendingChannelProvisioning(row.messaging_group_id, {
      provisioning_step: 'awaiting_confirmation',
      selected_model_id: model.id,
    });
    const endpoint = modelProvider.base_url ? ` via ${modelProvider.base_url}` : '';
    const delivered = await deliverRegistrationQuestion(
      row,
      '✅ Confirm new OpenCode agent',
      `Create "${row.new_agent_name}" with ${model.id}${endpoint}?`,
      [
        {
          label: 'Create and connect',
          selectedLabel: '✅ Creating…',
          value: CONFIRM_NEW_AGENT_VALUE,
          style: 'primary',
        },
        { label: 'Cancel', selectedLabel: '🙅 Cancelled', value: CANCEL_NEW_AGENT_VALUE },
      ],
    );
    if (!delivered) deletePendingChannelApproval(row.messaging_group_id);
    return true;
  }

  // ── Cancel OpenCode provisioning without denying the channel ──
  if (payload.value === CANCEL_NEW_AGENT_VALUE) {
    deletePendingChannelApproval(row.messaging_group_id);
    await deliverRegistrationText(
      row,
      'OpenCode agent creation cancelled. Mention the bot again to restart registration.',
    );
    return true;
  }

  // ── Confirm OpenCode provisioning ──
  if (payload.value === CONFIRM_NEW_AGENT_VALUE) {
    if (
      row.provisioning_step !== 'awaiting_confirmation' ||
      !row.new_agent_name ||
      !row.selected_provider_id ||
      !row.selected_model_id
    ) {
      log.warn('Channel registration: stale OpenCode confirmation ignored', {
        messagingGroupId: row.messaging_group_id,
        step: row.provisioning_step,
      });
      return true;
    }
    const modelProvider = getEnabledOpenCodeModelProvider(row.selected_provider_id);
    if (!modelProvider) {
      await deliverRegistrationText(row, 'That OpenCode provider is no longer available. Start again.');
      deletePendingChannelApproval(row.messaging_group_id);
      return true;
    }
    const models = await loadDiscoveredModels(row, modelProvider);
    if (!models) return true;
    const model = models.find((candidate) => candidate.id === row.selected_model_id);
    if (!model) {
      await deliverRegistrationText(row, 'That model is no longer available from the provider. Start again.');
      deletePendingChannelApproval(row.messaging_group_id);
      return true;
    }

    let ag: AgentGroup;
    try {
      ag = createNewAgentGroup(row.new_agent_name, modelProvider, model);
    } catch (err) {
      log.error('Channel registration: OpenCode agent provisioning failed', {
        messagingGroupId: row.messaging_group_id,
        agentName: row.new_agent_name,
        modelProviderId: modelProvider.id,
        modelId: model.id,
        err,
      });
      await deliverRegistrationText(
        row,
        'OpenCode agent creation failed before the channel was connected. Check the host logs, then press Create and connect again.',
      );
      return true;
    }
    log.info('Channel registration: provisioned OpenCode agent group', {
      messagingGroupId: row.messaging_group_id,
      agentGroupId: ag.id,
      agentName: ag.name,
      folder: ag.folder,
      modelProvider: modelProvider.provider_id,
      model: model.id,
      modelProviderId: modelProvider.id,
    });
    const wired = await wireApprovedChannel(row, ag.id, approverId);
    await deliverRegistrationText(
      row,
      wired
        ? `✅ OpenCode agent "${ag.name}" created with ${model.id} and connected.`
        : `⚠️ OpenCode agent "${ag.name}" was created but the channel couldn't be connected — check the host logs.`,
    );
    return true;
  }

  // ── Resolve existing target agent group ──
  let targetAgentGroupId: string;

  if (payload.value.startsWith(CONNECT_PREFIX)) {
    if (row.provisioning_step !== 'idle') return true;
    targetAgentGroupId = payload.value.slice(CONNECT_PREFIX.length);
    const ag = getAgentGroup(targetAgentGroupId);
    if (!ag) {
      log.error('Channel registration: target agent group no longer exists', {
        messagingGroupId: row.messaging_group_id,
        targetAgentGroupId,
      });
      deletePendingChannelApproval(row.messaging_group_id);
      return true;
    }
    if (!hasAdminPrivilege(approverId, targetAgentGroupId)) {
      log.warn('Channel registration: target agent group rejected for unauthorized approver', {
        messagingGroupId: row.messaging_group_id,
        targetAgentGroupId,
        approverId,
      });
      return true;
    }
  } else {
    log.warn('Channel registration: unknown response value', {
      messagingGroupId: row.messaging_group_id,
      value: payload.value,
    });
    return true;
  }

  // ── Wire + replay (shared path for connect and create) ──
  let event: InboundEvent;
  try {
    event = JSON.parse(row.original_message) as InboundEvent;
  } catch (err) {
    log.error('Channel registration: failed to parse stored event', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
    deletePendingChannelApproval(row.messaging_group_id);
    return true;
  }

  const isGroup = event.threadId !== null;
  const engageMode: MessagingGroupAgent['engage_mode'] = isGroup ? 'mention-sticky' : 'pattern';
  const engagePattern = isGroup ? null : '.';

  const mgaId = `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  createMessagingGroupAgent({
    id: mgaId,
    messaging_group_id: row.messaging_group_id,
    agent_group_id: targetAgentGroupId,
    engage_mode: engageMode,
    engage_pattern: engagePattern,
    sender_scope: 'known',
    ignored_message_policy: 'accumulate',
    session_mode: 'shared',
    priority: 0,
    created_at: new Date().toISOString(),
  });
  log.info('Channel registration approved — wiring created', {
    messagingGroupId: row.messaging_group_id,
    agentGroupId: targetAgentGroupId,
    mgaId,
    engageMode,
    approverId,
  });

  const senderUserId = extractAndUpsertUser(event);
  if (senderUserId) {
    addMember({
      user_id: senderUserId,
      agent_group_id: targetAgentGroupId,
      added_by: approverId,
      added_at: new Date().toISOString(),
    });
  }

  deletePendingChannelApproval(row.messaging_group_id);

  try {
    await routeInbound(event);
  } catch (err) {
    log.error('Failed to replay message after channel approval', {
      messagingGroupId: row.messaging_group_id,
      err,
    });
  }
  return true;
}

registerResponseHandler(handleChannelApprovalResponse);

// ── Restart-safe free-text provisioning interceptor ──
// Captures either the new-agent name or a model-catalog search query.

registerMessageInterceptor(async (event: InboundEvent): Promise<boolean> => {
  const userId = extractAndUpsertUser(event);
  if (!userId) return false;

  const row = getPendingTextInputForApprover(userId);
  if (!row) return false;
  const approverDm = await ensureUserDm(userId);
  if (!approverDm || event.channelType !== approverDm.channel_type || event.platformId !== approverDm.platform_id) {
    return false;
  }

  let text: string | undefined;
  try {
    const parsed = JSON.parse(event.message.content) as Record<string, unknown>;
    text = (typeof parsed.text === 'string' ? parsed.text : undefined)?.trim();
  } catch {
    /* fall through */
  }

  if (!text) {
    log.warn('Channel registration: empty provisioning reply, ignoring', { userId });
    return true;
  }

  if (text.toLowerCase() === 'cancel' || text.toLowerCase() === '/cancel') {
    deletePendingChannelApproval(row.messaging_group_id);
    await deliverRegistrationText(row, 'Agent creation cancelled.');
    return true;
  }

  if (row.provisioning_step === 'awaiting_model_query') {
    if (!row.selected_provider_id) {
      deletePendingChannelApproval(row.messaging_group_id);
      return true;
    }
    const modelProvider = getEnabledOpenCodeModelProvider(row.selected_provider_id);
    if (!modelProvider) {
      await deliverRegistrationText(row, 'That OpenCode provider is no longer available. Start again.');
      deletePendingChannelApproval(row.messaging_group_id);
      return true;
    }
    const models = await loadDiscoveredModels(row, modelProvider);
    if (!models) return true;
    const matches = filterDiscoveredModels(models, text);
    if (matches.length === 0) {
      await deliverRegistrationText(row, `No ${modelProvider.name} models matched "${text}". Try another search.`);
      return true;
    }
    if (matches.length > MODEL_OPTION_LIMIT) {
      await deliverRegistrationText(
        row,
        `${matches.length} ${modelProvider.name} models matched "${text}". Reply with a more specific name or ID.`,
      );
      return true;
    }
    await offerDiscoveredModels(row, modelProvider, matches);
    return true;
  }

  const modelProviders = listEnabledOpenCodeModelProviders();
  if (modelProviders.length === 0) {
    deletePendingChannelApproval(row.messaging_group_id);
    await deliverRegistrationText(
      row,
      'No enabled OpenCode model providers are configured. Add one with `ncl opencode-model-providers create`, then mention the bot again.',
    );
    return true;
  }

  updatePendingChannelProvisioning(row.messaging_group_id, {
    provisioning_step: 'awaiting_provider',
    new_agent_name: text,
    selected_provider_id: null,
    selected_model_id: null,
  });
  const delivered = await deliverRegistrationQuestion(
    row,
    '☁️ Choose an OpenCode provider',
    `Which model provider should "${text}" use?`,
    [
      ...modelProviders.map((modelProvider) => ({
        label: modelProvider.name,
        selectedLabel: `✅ ${modelProvider.name}`,
        value: `${OPENCODE_PROVIDER_PREFIX}${encodeURIComponent(modelProvider.id)}`,
      })),
      { label: 'Cancel', selectedLabel: '🙅 Cancelled', value: CANCEL_NEW_AGENT_VALUE },
    ],
  );
  if (!delivered) deletePendingChannelApproval(row.messaging_group_id);
  return true;
});
