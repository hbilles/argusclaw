/**
 * ArgusClaw Slack Bridge
 *
 * Connects to Slack via @slack/bolt (Socket Mode) and forwards
 * allowed messages to the Gateway over a Unix domain socket.
 *
 * Features:
 * - Socket Mode (WebSocket) — no public URL required
 * - Channel mentions (@bot) reply in threads to keep channels clean
 * - DMs handled directly (no threading)
 * - HITL approval flow via Block Kit interactive buttons
 * - Slash commands and text-based fallback commands
 * - Multi-channel support (bot can be added to any channel)
 */

import { App, LogLevel } from '@slack/bolt';
import { randomUUID } from 'node:crypto';
import { SocketClient } from '@argusclaw/shared';
import {
  slackChatId,
  extractSlackChannel,
  formatToolSummary,
  cleanLLMResponse,
  markdownToMrkdwn,
  splitMessage,
} from './formatting.js';
import type {
  Message,
  SocketRequest,
  SocketResponse,
  ApprovalRequest,
  ApprovalDecision,
  BridgeNotification,
  ApprovalExpired,
  TaskProgressUpdate,
  MemoryListRequest,
  MemoryListResponse,
  MemoryDeleteRequest,
  MemoryDeleteResponse,
  SessionListRequest,
  SessionListResponse,
  TaskStopRequest,
  TaskStopResponse,
  // Phase 5
  HeartbeatListRequest,
  HeartbeatListResponse,
  HeartbeatToggleRequest,
  HeartbeatToggleResponse,
  HeartbeatTriggered,
  // Phase 9
  AuthServiceName,
  AuthConnectRequest,
  AuthStatusRequest,
  AuthDisconnectRequest,
  AuthResponse,
} from '@argusclaw/shared';

// ---------------------------------------------------------------------------
// Environment validation
// ---------------------------------------------------------------------------

const SLACK_BOT_TOKEN = process.env['SLACK_BOT_TOKEN'];
if (!SLACK_BOT_TOKEN) {
  console.error('[bridge-slack] FATAL: SLACK_BOT_TOKEN environment variable is not set');
  process.exit(1);
}

const SLACK_APP_TOKEN = process.env['SLACK_APP_TOKEN'];
if (!SLACK_APP_TOKEN) {
  console.error('[bridge-slack] FATAL: SLACK_APP_TOKEN environment variable is not set (required for Socket Mode)');
  process.exit(1);
}

const SLACK_ALLOWED_USER_IDS: Set<string> = new Set(
  (process.env['SLACK_ALLOWED_USER_IDS'] ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id.length > 0),
);

if (SLACK_ALLOWED_USER_IDS.size === 0) {
  console.warn('[bridge-slack] WARNING: SLACK_ALLOWED_USER_IDS is empty — all messages will be ignored');
}

console.log(`[bridge-slack] Allowlist: ${SLACK_ALLOWED_USER_IDS.size} user(s)`);

// ---------------------------------------------------------------------------
// Pending request tracking (for correlating socket responses)
// ---------------------------------------------------------------------------

interface PendingRequest {
  channel: string;
  threadTs?: string;
}

const pendingRequests: Map<string, PendingRequest> = new Map();

// ---------------------------------------------------------------------------
// Approval message tracking
// Maps approval IDs to their Slack message details so we can update them later
// ---------------------------------------------------------------------------

interface ApprovalMessageRef {
  channel: string;
  ts: string;
}

const approvalMessages: Map<string, ApprovalMessageRef> = new Map();
const resolvedApprovals: Set<string> = new Set();

// ---------------------------------------------------------------------------
// Thread tracking — maps chatId to the most recent threadTs for that channel.
// Used so gateway responses (notifications, heartbeats) can reply in the right thread.
// ---------------------------------------------------------------------------

const channelThreads: Map<string, string> = new Map();

// ---------------------------------------------------------------------------
// Initialize Bolt app and socket client
// ---------------------------------------------------------------------------

const app = new App({
  token: SLACK_BOT_TOKEN,
  appToken: SLACK_APP_TOKEN,
  socketMode: true,
  logLevel: LogLevel.WARN,
});

const socketClient = new SocketClient();

// ---------------------------------------------------------------------------
// Slash Command Handlers
// ---------------------------------------------------------------------------

/**
 * /argus_memories — List all memories, grouped by category.
 */
app.command('/argus_memories', async ({ command, ack }) => {
  await ack();
  const userId = command.user_id;
  if (!SLACK_ALLOWED_USER_IDS.has(userId)) return;

  const chatId = slackChatId(command.channel_id);

  const request: MemoryListRequest = {
    type: 'memory-list',
    userId,
    chatId,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-slack] Sent memory-list request for user ${userId}`);
  } else {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: 'Sorry, I\'m not connected to the gateway right now.',
    });
  }
});

/**
 * /argus_forget <topic> — Delete a memory by topic.
 */
app.command('/argus_forget', async ({ command, ack }) => {
  await ack();
  const userId = command.user_id;
  if (!SLACK_ALLOWED_USER_IDS.has(userId)) return;

  const chatId = slackChatId(command.channel_id);
  const topic = command.text?.trim();

  if (!topic) {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: 'Usage: `/argus_forget <topic>`\n\nExample: `/argus_forget coding style`',
    });
    return;
  }

  const request: MemoryDeleteRequest = {
    type: 'memory-delete',
    userId,
    chatId,
    topic,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-slack] Sent memory-delete request for topic "${topic}"`);
  } else {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: 'Sorry, I\'m not connected to the gateway right now.',
    });
  }
});

/**
 * /argus_sessions — Show active/recent sessions.
 */
app.command('/argus_sessions', async ({ command, ack }) => {
  await ack();
  const userId = command.user_id;
  if (!SLACK_ALLOWED_USER_IDS.has(userId)) return;

  const chatId = slackChatId(command.channel_id);

  const request: SessionListRequest = {
    type: 'session-list',
    userId,
    chatId,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-slack] Sent session-list request for user ${userId}`);
  } else {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: 'Sorry, I\'m not connected to the gateway right now.',
    });
  }
});

/**
 * /argus_stop — Cancel the current multi-step task.
 */
app.command('/argus_stop', async ({ command, ack }) => {
  await ack();
  const userId = command.user_id;
  if (!SLACK_ALLOWED_USER_IDS.has(userId)) return;

  const chatId = slackChatId(command.channel_id);

  const request: TaskStopRequest = {
    type: 'task-stop',
    userId,
    chatId,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-slack] Sent task-stop request for user ${userId}`);
  } else {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: 'Sorry, I\'m not connected to the gateway right now.',
    });
  }
});

/**
 * /argus_heartbeats — List all heartbeats and their status.
 */
app.command('/argus_heartbeats', async ({ command, ack }) => {
  await ack();
  const userId = command.user_id;
  if (!SLACK_ALLOWED_USER_IDS.has(userId)) return;

  const chatId = slackChatId(command.channel_id);

  const request: HeartbeatListRequest = {
    type: 'heartbeat-list',
    userId,
    chatId,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-slack] Sent heartbeat-list request for user ${userId}`);
  } else {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: 'Sorry, I\'m not connected to the gateway right now.',
    });
  }
});

/**
 * /argus_connect <service> — Start OAuth login flow.
 */
app.command('/argus_connect', async ({ command, ack }) => {
  await ack();
  const userId = command.user_id;
  if (!SLACK_ALLOWED_USER_IDS.has(userId)) return;

  const chatId = slackChatId(command.channel_id);
  const args = (command.text ?? '').trim();

  if (!args) {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: ':lock: Usage:\n`/argus_connect codex`\n`/argus_connect google`\n`/argus_connect <service> callback <url-or-code>`',
    });
    return;
  }

  const parts = args.split(/\s+/);
  const service = parts[0]?.toLowerCase();
  const validServices: AuthServiceName[] = ['codex', 'google'];
  if (!service || !validServices.includes(service as AuthServiceName)) {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: ':warning: Supported auth services: `codex`, `google`',
    });
    return;
  }

  const callbackInput =
    parts[1]?.toLowerCase() === 'callback'
      ? args.slice(args.toLowerCase().indexOf('callback') + 'callback'.length).trim()
      : undefined;

  if (parts[1]?.toLowerCase() === 'callback' && !callbackInput) {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: `:warning: Usage: \`/argus_connect ${service} callback <url-or-code>\``,
    });
    return;
  }

  const request: AuthConnectRequest = {
    type: 'auth-connect',
    userId,
    chatId,
    service: service as AuthServiceName,
    callbackInput,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-slack] Sent auth-connect request for ${service}`);
  } else {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: 'Sorry, I\'m not connected to the gateway right now.',
    });
  }
});

/**
 * /argus_auth_status <service>
 */
app.command('/argus_auth_status', async ({ command, ack }) => {
  await ack();
  const userId = command.user_id;
  if (!SLACK_ALLOWED_USER_IDS.has(userId)) return;

  const chatId = slackChatId(command.channel_id);
  const service = (command.text ?? '').trim().toLowerCase() || 'codex';
  const validServices: AuthServiceName[] = ['codex', 'google'];
  if (!validServices.includes(service as AuthServiceName)) {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: ':warning: Supported auth services: `codex`, `google`',
    });
    return;
  }

  const request: AuthStatusRequest = {
    type: 'auth-status',
    userId,
    chatId,
    service: service as AuthServiceName,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-slack] Sent auth-status request for ${service}`);
  } else {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: 'Sorry, I\'m not connected to the gateway right now.',
    });
  }
});

/**
 * /argus_disconnect <service>
 */
app.command('/argus_disconnect', async ({ command, ack }) => {
  await ack();
  const userId = command.user_id;
  if (!SLACK_ALLOWED_USER_IDS.has(userId)) return;

  const chatId = slackChatId(command.channel_id);
  const service = (command.text ?? '').trim().toLowerCase();
  const validServices: AuthServiceName[] = ['codex', 'google'];
  if (!service || !validServices.includes(service as AuthServiceName)) {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: ':warning: Usage: `/argus_disconnect codex` or `/argus_disconnect google`',
    });
    return;
  }

  const request: AuthDisconnectRequest = {
    type: 'auth-disconnect',
    userId,
    chatId,
    service: service as AuthServiceName,
  };

  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-slack] Sent auth-disconnect request for ${service}`);
  } else {
    await app.client.chat.postMessage({
      channel: command.channel_id,
      text: 'Sorry, I\'m not connected to the gateway right now.',
    });
  }
});

// ---------------------------------------------------------------------------
// Handle incoming Slack messages — @mentions in channels
// ---------------------------------------------------------------------------

app.event('app_mention', async ({ event }) => {
  const userId = event.user;
  if (!userId) return;

  // Security boundary: silently ignore non-allowlisted users
  if (!SLACK_ALLOWED_USER_IDS.has(userId)) {
    return;
  }

  const channel = event.channel;
  const chatId = slackChatId(channel);

  // Strip the bot mention from the message text
  const content = (event.text ?? '').replace(/<@[A-Z0-9]+>/g, '').trim();
  if (!content) return;

  // Check for text-based commands
  if (await handleTextCommand(content, userId, channel)) return;

  // Thread handling: if mentioned inside a thread, continue it; otherwise start a new one
  const threadTs = event.thread_ts ?? event.ts;

  // Track the thread for this channel so responses route correctly
  channelThreads.set(chatId, threadTs);

  const message: Message = {
    id: randomUUID(),
    sourceId: event.ts,
    source: 'slack',
    userId,
    content,
    timestamp: new Date(parseFloat(event.ts) * 1000),
    metadata: {
      chatId,
      channel,
      threadTs,
    },
  };

  const requestId = randomUUID();

  // Track the pending request so we know where to send the response
  pendingRequests.set(requestId, {
    channel,
    threadTs,
  });

  // Build socket request
  const request: SocketRequest = {
    requestId,
    message,
    replyTo: {
      chatId,
      messageId: event.ts,
    },
  };

  // Send to gateway
  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-slack] Forwarded mention from user ${userId} in ${channel} (request: ${requestId})`);
  } else {
    console.warn('[bridge-slack] Cannot forward message — not connected to gateway');
    pendingRequests.delete(requestId);
    await app.client.chat.postMessage({
      channel,
      text: 'Sorry, I\'m temporarily unable to process messages. Please try again in a moment.',
      thread_ts: threadTs,
    });
  }
});

// ---------------------------------------------------------------------------
// Handle incoming Slack messages — DMs
// ---------------------------------------------------------------------------

app.event('message', async ({ event }) => {
  // Only handle DMs (im = direct message)
  // Cast through unknown since the Slack event union type doesn't have a clean index signature
  const ev = event as unknown as Record<string, unknown>;
  if (ev['channel_type'] !== 'im') return;

  // Ignore message subtypes (edits, deletes, bot messages, etc.)
  if (ev['subtype']) return;

  const userId = ev['user'] as string | undefined;
  if (!userId) return;

  // Security boundary: silently ignore non-allowlisted users
  if (!SLACK_ALLOWED_USER_IDS.has(userId)) {
    return;
  }

  const channel = ev['channel'] as string;
  const chatId = slackChatId(channel);
  const text = ev['text'] as string | undefined;
  if (!text || !text.trim()) return;

  const content = text.trim();

  // Check for text-based commands
  if (await handleTextCommand(content, userId, channel)) return;

  const ts = ev['ts'] as string;

  const message: Message = {
    id: randomUUID(),
    sourceId: ts,
    source: 'slack',
    userId,
    content,
    timestamp: new Date(parseFloat(ts) * 1000),
    metadata: {
      chatId,
      channel,
    },
  };

  const requestId = randomUUID();

  // Track the pending request (no thread for DMs)
  pendingRequests.set(requestId, {
    channel,
  });

  // Build socket request
  const request: SocketRequest = {
    requestId,
    message,
    replyTo: {
      chatId,
      messageId: ts,
    },
  };

  // Send to gateway
  if (socketClient.connected) {
    socketClient.send(request);
    console.log(`[bridge-slack] Forwarded DM from user ${userId} (request: ${requestId})`);
  } else {
    console.warn('[bridge-slack] Cannot forward message — not connected to gateway');
    pendingRequests.delete(requestId);
    await app.client.chat.postMessage({
      channel,
      text: 'Sorry, I\'m temporarily unable to process messages. Please try again in a moment.',
    });
  }
});

// ---------------------------------------------------------------------------
// Text-based command fallback (works without slash command setup)
// ---------------------------------------------------------------------------

async function handleTextCommand(content: string, userId: string, channel: string): Promise<boolean> {
  const chatId = slackChatId(channel);

  if (content === '!memories') {
    const request: MemoryListRequest = { type: 'memory-list', userId, chatId };
    if (socketClient.connected) socketClient.send(request);
    return true;
  }

  if (content.startsWith('!forget ')) {
    const topic = content.slice(8).trim();
    if (topic) {
      const request: MemoryDeleteRequest = { type: 'memory-delete', userId, chatId, topic };
      if (socketClient.connected) socketClient.send(request);
    }
    return true;
  }

  if (content === '!sessions') {
    const request: SessionListRequest = { type: 'session-list', userId, chatId };
    if (socketClient.connected) socketClient.send(request);
    return true;
  }

  if (content === '!stop') {
    const request: TaskStopRequest = { type: 'task-stop', userId, chatId };
    if (socketClient.connected) socketClient.send(request);
    return true;
  }

  if (content === '!heartbeats') {
    const request: HeartbeatListRequest = { type: 'heartbeat-list', userId, chatId };
    if (socketClient.connected) socketClient.send(request);
    return true;
  }

  const enableMatch = content.match(/^!heartbeat_enable\s+(.+)$/i);
  if (enableMatch) {
    const request: HeartbeatToggleRequest = {
      type: 'heartbeat-toggle', userId, chatId,
      name: enableMatch[1]!.trim(), enabled: true,
    };
    if (socketClient.connected) socketClient.send(request);
    return true;
  }

  const disableMatch = content.match(/^!heartbeat_disable\s+(.+)$/i);
  if (disableMatch) {
    const request: HeartbeatToggleRequest = {
      type: 'heartbeat-toggle', userId, chatId,
      name: disableMatch[1]!.trim(), enabled: false,
    };
    if (socketClient.connected) socketClient.send(request);
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// Handle interactive actions (approval buttons)
// ---------------------------------------------------------------------------

app.action('approve_action', async ({ action, ack, body }) => {
  await ack();
  await handleApprovalAction(action as unknown, body as unknown as Record<string, unknown>, 'approved');
});

app.action('session_approve_action', async ({ action, ack, body }) => {
  await ack();
  await handleApprovalAction(action as unknown, body as unknown as Record<string, unknown>, 'session-approved');
});

app.action('reject_action', async ({ action, ack, body }) => {
  await ack();
  await handleApprovalAction(action as unknown, body as unknown as Record<string, unknown>, 'rejected');
});

async function handleApprovalAction(
  action: unknown,
  body: Record<string, unknown>,
  decision: 'approved' | 'rejected' | 'session-approved',
): Promise<void> {
  const user = body['user'] as Record<string, unknown> | undefined;
  const userId = user?.['id'] as string | undefined;
  if (!userId || !SLACK_ALLOWED_USER_IDS.has(userId)) return;

  const btnAction = action as Record<string, unknown>;
  const approvalId = btnAction['value'] as string;

  // Check if this approval has already been resolved
  if (resolvedApprovals.has(approvalId)) {
    return;
  }

  // Send the decision to the gateway
  const approvalDecision: ApprovalDecision = {
    type: 'approval-decision',
    approvalId,
    decision,
  };

  if (socketClient.connected) {
    socketClient.send(approvalDecision);
    console.log(`[bridge-slack] Sent approval decision: ${approvalId} → ${decision}`);
  }

  // Mark as resolved
  resolvedApprovals.add(approvalId);
  approvalMessages.delete(approvalId);

  // Update the original message to show the decision (remove buttons)
  const statusEmoji = decision === 'approved' ? ':white_check_mark:' : decision === 'session-approved' ? ':arrows_counterclockwise:' : ':x:';
  const statusText = decision === 'approved' ? 'Approved' : decision === 'session-approved' ? 'Allowed for Session' : 'Rejected';

  try {
    const msgBody = body['message'] as Record<string, unknown> | undefined;
    const channelObj = body['channel'] as Record<string, unknown> | undefined;
    const channelId = channelObj?.['id'] as string;
    const msgTs = msgBody?.['ts'] as string;

    if (channelId && msgTs) {
      // Get original text from first section block
      const blocks = msgBody?.['blocks'] as Array<Record<string, unknown>> | undefined;
      let originalText = '';
      if (blocks) {
        for (const block of blocks) {
          if (block['type'] === 'section') {
            const textObj = block['text'] as Record<string, unknown> | undefined;
            if (textObj?.['text']) {
              originalText = textObj['text'] as string;
              break;
            }
          }
        }
      }

      await app.client.chat.update({
        channel: channelId,
        ts: msgTs,
        text: `${originalText}\n\n${statusEmoji} ${statusText}`,
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: `${originalText}\n\n${statusEmoji} *${statusText}*`,
            },
          },
        ],
      });
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-slack] Failed to update approval message:', error.message);
  }
}

// ---------------------------------------------------------------------------
// Handle socket messages from gateway
// ---------------------------------------------------------------------------

socketClient.on('message', async (data: unknown) => {
  const raw = data as Record<string, unknown>;

  // Only handle messages destined for Slack (chatId starts with 'slack:')
  const msgChatId = (raw['chatId'] ?? (raw['outgoing'] as Record<string, unknown> | undefined)?.['chatId']) as string | undefined;
  if (!msgChatId || !msgChatId.startsWith('slack:')) {
    return;
  }

  const channelId = extractSlackChannel(msgChatId)!;

  // Route based on message type
  switch (raw['type']) {
    case 'approval-request':
      await handleApprovalRequest(data as ApprovalRequest, channelId);
      return;

    case 'notification':
      await handleNotification(data as BridgeNotification, channelId);
      return;

    case 'approval-expired':
      await handleApprovalExpired(data as ApprovalExpired, channelId);
      return;

    case 'task-progress':
      await handleTaskProgress(data as TaskProgressUpdate, channelId);
      return;

    case 'memory-list-response':
      await handleMemoryListResponse(data as MemoryListResponse, channelId);
      return;

    case 'memory-delete-response':
      await handleMemoryDeleteResponse(data as MemoryDeleteResponse, channelId);
      return;

    case 'session-list-response':
      await handleSessionListResponse(data as SessionListResponse, channelId);
      return;

    case 'task-stop-response':
      await handleTaskStopResponse(data as TaskStopResponse, channelId);
      return;

    case 'heartbeat-list-response':
      await handleHeartbeatListResponse(data as HeartbeatListResponse, channelId);
      return;

    case 'heartbeat-toggle-response':
      await handleHeartbeatToggleResponse(data as HeartbeatToggleResponse, channelId);
      return;

    case 'heartbeat-triggered':
      await handleHeartbeatTriggered(data as HeartbeatTriggered, channelId);
      return;

    case 'auth-response':
      await handleAuthResponse(data as AuthResponse, channelId);
      return;

    default:
      // Standard socket response (no type field)
      await handleSocketResponse(data as SocketResponse);
      return;
  }
});

// ---------------------------------------------------------------------------
// Message handlers
// ---------------------------------------------------------------------------

/**
 * Handle an approval request from the gateway.
 * Sends a Block Kit message with Approve/Reject buttons.
 */
async function handleApprovalRequest(request: ApprovalRequest, channelId: string): Promise<void> {
  const { approvalId, toolName, toolInput, reason, planContext, metadata } = request;

  const cleanReason = reason ? cleanLLMResponse(reason) : '';
  const isDomainRequest = metadata?.type === 'domain-request' && metadata.domain;

  // Build the approval message text
  let messageText: string;
  if (isDomainRequest) {
    messageText = `:globe_with_meridians: *New Domain Request*\n\nThe agent wants to visit: \`${metadata.domain}\`\nThis domain is not on the allowed list.`;
  } else {
    const toolSummary = formatToolSummary(toolName, toolInput);
    messageText = `:lock: *Approval Required*\n\nThe agent wants to:\n:memo: ${toolSummary}`;
  }

  if (cleanReason) {
    // Truncate reason to fit within Block Kit's 3000-char limit
    const maxReasonLen = Math.min(cleanReason.length, 2500);
    const truncatedReason = cleanReason.length > maxReasonLen
      ? cleanReason.slice(0, maxReasonLen) + '... (truncated)'
      : cleanReason;
    messageText += `\n\n_"${truncatedReason}"_`;
  }

  if (planContext) {
    messageText += `\n\nContext: ${planContext.slice(0, 500)}`;
  }

  const approveLabel = isDomainRequest ? 'Allow Once' : 'Approve';

  // Get thread context for this channel
  const threadTs = channelThreads.get(slackChatId(channelId));

  try {
    const result = await app.client.chat.postMessage({
      channel: channelId,
      text: `Approval required: ${toolName}`,
      thread_ts: threadTs,
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: messageText,
          },
        },
        {
          type: 'actions',
          elements: [
            {
              type: 'button',
              text: { type: 'plain_text', text: approveLabel },
              style: 'primary',
              action_id: 'approve_action',
              value: approvalId,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Allow for Session' },
              action_id: 'session_approve_action',
              value: approvalId,
            },
            {
              type: 'button',
              text: { type: 'plain_text', text: 'Reject' },
              style: 'danger',
              action_id: 'reject_action',
              value: approvalId,
            },
          ],
        },
      ],
    });

    if (result.ts) {
      approvalMessages.set(approvalId, {
        channel: channelId,
        ts: result.ts,
      });
    }

    console.log(`[bridge-slack] Sent approval request: ${approvalId} (ts: ${result.ts})`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-slack] Failed to send approval request:', error.message);
  }
}

/**
 * Handle a notification from the gateway.
 */
async function handleNotification(notification: BridgeNotification, channelId: string): Promise<void> {
  const { text } = notification;

  try {
    const threadTs = channelThreads.get(slackChatId(channelId));
    await sendFormattedMessage(channelId, text, threadTs);
    console.log(`[bridge-slack] Sent notification to channel ${channelId}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-slack] Failed to send notification:', error.message);
  }
}

/**
 * Handle an approval expiry from the gateway.
 * Updates the original Slack message to show it expired and removes buttons.
 */
async function handleApprovalExpired(expired: ApprovalExpired, channelId: string): Promise<void> {
  const { approvalId } = expired;

  // Mark as resolved so late button presses are rejected
  resolvedApprovals.add(approvalId);

  const ref = approvalMessages.get(approvalId);
  approvalMessages.delete(approvalId);

  if (ref) {
    try {
      await app.client.chat.update({
        channel: ref.channel,
        ts: ref.ts,
        text: 'Approval expired',
        blocks: [
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: ':alarm_clock: *Approval Expired*\n\nThis approval request timed out after 5 minutes. The action was not executed.',
            },
          },
        ],
      });
      console.log(`[bridge-slack] Marked approval ${approvalId} as expired`);
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error('[bridge-slack] Failed to edit expired approval message:', error.message);
    }
  } else {
    // No tracked message — send a new notification
    try {
      await app.client.chat.postMessage({
        channel: channelId,
        text: ':alarm_clock: An approval request expired before you responded. The action was not executed.',
      });
    } catch {
      // Best-effort notification
    }
  }
}

/**
 * Handle a task progress update from the gateway.
 */
async function handleTaskProgress(progress: TaskProgressUpdate, channelId: string): Promise<void> {
  const { text } = progress;

  try {
    const threadTs = channelThreads.get(slackChatId(channelId));
    const mrkdwn = markdownToMrkdwn(text);
    await app.client.chat.postMessage({
      channel: channelId,
      text: mrkdwn,
      thread_ts: threadTs,
    });
    console.log(`[bridge-slack] Sent task progress to channel ${channelId}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-slack] Failed to send task progress:', error.message);
  }
}

/**
 * Handle memory list response — format and send to the user.
 */
async function handleMemoryListResponse(response: MemoryListResponse, channelId: string): Promise<void> {
  const { memories } = response;

  if (memories.length === 0) {
    try {
      await app.client.chat.postMessage({
        channel: channelId,
        text: ':brain: No memories stored yet.',
      });
    } catch {
      // Best-effort
    }
    return;
  }

  // Group by category
  const grouped = new Map<string, typeof memories>();
  for (const m of memories) {
    if (!grouped.has(m.category)) {
      grouped.set(m.category, []);
    }
    grouped.get(m.category)!.push(m);
  }

  let text = ':brain: *Memories*\n\n';
  const categoryEmojis: Record<string, string> = {
    user: ':bust_in_silhouette:',
    preference: ':gear:',
    project: ':file_folder:',
    fact: ':pushpin:',
    environment: ':computer:',
  };

  for (const [category, items] of grouped) {
    const emoji = categoryEmojis[category] ?? ':pencil:';
    text += `${emoji} *${category}*\n`;

    for (const item of items) {
      const content = item.content.length > 100
        ? item.content.slice(0, 100) + '...'
        : item.content;
      text += `  \u2022 \`${item.topic}\`: ${content}\n`;
    }
    text += '\n';
  }

  text += `_${memories.length} total memory(ies). Use \`/argus_forget <topic>\` or \`!forget <topic>\` to remove one._`;

  // Slack blocks have a 3000-char limit per section
  if (text.length > 2900) {
    text = text.slice(0, 2850) + '\n\n_...truncated. Too many memories to display._';
  }

  try {
    await app.client.chat.postMessage({
      channel: channelId,
      text: 'Memories list',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
      ],
    });
    console.log(`[bridge-slack] Sent memory list (${memories.length} items) to channel ${channelId}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-slack] Failed to send memory list:', error.message);
    // Fallback: plain message
    try {
      await app.client.chat.postMessage({
        channel: channelId,
        text: `:brain: ${memories.length} memories stored. (Failed to format — try \`!forget <topic>\` to manage)`,
      });
    } catch {
      // Best-effort
    }
  }
}

/**
 * Handle memory delete response.
 */
async function handleMemoryDeleteResponse(response: MemoryDeleteResponse, channelId: string): Promise<void> {
  const { success, topic } = response;

  const text = success
    ? `:white_check_mark: Forgot: "${topic}"`
    : `:warning: No memory found with topic "${topic}"`;

  try {
    await app.client.chat.postMessage({ channel: channelId, text });
    console.log(`[bridge-slack] Memory delete result for "${topic}": ${success}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-slack] Failed to send memory delete response:', error.message);
  }
}

/**
 * Handle session list response.
 */
async function handleSessionListResponse(response: SessionListResponse, channelId: string): Promise<void> {
  const { sessions } = response;

  if (sessions.length === 0) {
    try {
      await app.client.chat.postMessage({
        channel: channelId,
        text: ':clipboard: No recent task sessions.',
      });
    } catch {
      // Best-effort
    }
    return;
  }

  let text = ':clipboard: *Recent Sessions*\n\n';

  const statusEmojis: Record<string, string> = {
    active: ':arrows_counterclockwise:',
    completed: ':white_check_mark:',
    failed: ':x:',
    paused: ':double_vertical_bar:',
  };

  for (const session of sessions) {
    const emoji = statusEmojis[session.status] ?? ':question:';
    const request = session.originalRequest.length > 80
      ? session.originalRequest.slice(0, 80) + '...'
      : session.originalRequest;
    const date = new Date(session.createdAt).toLocaleDateString();

    text += `${emoji} *${session.status}* (${date})\n`;
    text += `  _${request}_\n`;
    text += `  Iterations: ${session.iteration}/${session.maxIterations}\n\n`;
  }

  if (sessions.some((s) => s.status === 'active')) {
    text += '_Use `/argus_stop` or `!stop` to cancel an active task._';
  }

  try {
    await app.client.chat.postMessage({
      channel: channelId,
      text: 'Session list',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
      ],
    });
    console.log(`[bridge-slack] Sent session list (${sessions.length} items) to channel ${channelId}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-slack] Failed to send session list:', error.message);
  }
}

/**
 * Handle task stop response.
 */
async function handleTaskStopResponse(response: TaskStopResponse, channelId: string): Promise<void> {
  const { cancelled, sessionId } = response;

  const text = cancelled
    ? `:stop_sign: Task cancelled${sessionId ? ` (session: ${sessionId.slice(0, 8)}...)` : ''}`
    : ':warning: No active task to cancel.';

  try {
    await app.client.chat.postMessage({ channel: channelId, text });
    console.log(`[bridge-slack] Task stop result: cancelled=${cancelled}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-slack] Failed to send task stop response:', error.message);
  }
}

/**
 * Handle a standard socket response from the gateway.
 * Sends the response text back to the Slack channel.
 */
async function handleSocketResponse(response: SocketResponse): Promise<void> {
  if (!response.requestId || !response.outgoing) {
    console.error('[bridge-slack] Invalid response from gateway:', response);
    return;
  }

  const { requestId, outgoing } = response;
  const channelId = extractSlackChannel(outgoing.chatId);
  if (!channelId) return;

  // Look up pending request for thread context
  const pending = pendingRequests.get(requestId);
  pendingRequests.delete(requestId);

  try {
    await sendFormattedMessage(channelId, outgoing.content, pending?.threadTs);
    console.log(`[bridge-slack] Sent response for request ${requestId}`);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error(`[bridge-slack] Failed to send message for request ${requestId}:`, error.message);
  }
}

// ---------------------------------------------------------------------------
// Heartbeat Handlers
// ---------------------------------------------------------------------------

/**
 * Handle heartbeat list response.
 */
async function handleHeartbeatListResponse(response: HeartbeatListResponse, channelId: string): Promise<void> {
  const { heartbeats } = response;

  if (heartbeats.length === 0) {
    try {
      await app.client.chat.postMessage({
        channel: channelId,
        text: ':alarm_clock: No heartbeats configured.',
      });
    } catch {
      // Best-effort
    }
    return;
  }

  let text = ':alarm_clock: *Heartbeats*\n\n';

  for (const hb of heartbeats) {
    const status = hb.enabled ? ':large_green_circle: Enabled' : ':red_circle: Disabled';
    const prompt = hb.prompt.length > 100 ? hb.prompt.slice(0, 100) + '...' : hb.prompt;
    text += `*${hb.name}* — ${status}\n`;
    text += `  Schedule: \`${hb.schedule}\`\n`;
    text += `  Prompt: _${prompt}_\n\n`;
  }

  text += '_Commands:_\n';
  text += '`/argus_heartbeats` or `!heartbeats` — List heartbeats\n';
  text += '`!heartbeat_enable <name>` — Enable a heartbeat\n';
  text += '`!heartbeat_disable <name>` — Disable a heartbeat';

  try {
    await app.client.chat.postMessage({
      channel: channelId,
      text: 'Heartbeats list',
      blocks: [
        {
          type: 'section',
          text: { type: 'mrkdwn', text },
        },
      ],
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-slack] Failed to send heartbeat list:', error.message);
    try {
      await app.client.chat.postMessage({
        channel: channelId,
        text: `:alarm_clock: ${heartbeats.length} heartbeat(s) configured.`,
      });
    } catch {
      // Best-effort
    }
  }
}

/**
 * Handle heartbeat toggle response.
 */
async function handleHeartbeatToggleResponse(response: HeartbeatToggleResponse, channelId: string): Promise<void> {
  const { name, enabled, success } = response;

  const text = success
    ? `:alarm_clock: Heartbeat "${name}" ${enabled ? 'enabled :white_check_mark:' : 'disabled :red_circle:'}`
    : `:warning: Heartbeat "${name}" not found.`;

  try {
    await app.client.chat.postMessage({ channel: channelId, text });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-slack] Failed to send heartbeat toggle response:', error.message);
  }
}

/**
 * Handle heartbeat triggered notification.
 */
async function handleHeartbeatTriggered(triggered: HeartbeatTriggered, channelId: string): Promise<void> {
  const { name } = triggered;

  try {
    await app.client.chat.postMessage({
      channel: channelId,
      text: `:alarm_clock: Heartbeat "${name}" triggered...`,
    });
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-slack] Failed to send heartbeat triggered notification:', error.message);
  }
}

/**
 * Handle auth action responses from the gateway.
 */
async function handleAuthResponse(response: AuthResponse, channelId: string): Promise<void> {
  const { message } = response;
  try {
    await sendFormattedMessage(channelId, message);
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[bridge-slack] Failed to send auth response:', error.message);
  }
}

/**
 * Send a formatted message to Slack, with fallback and chunking.
 *
 * 1. Strips <think> tags
 * 2. Converts Markdown → Slack mrkdwn
 * 3. Splits into chunks if over 3000 chars
 * 4. Sends each chunk with a small delay to respect rate limits
 */
async function sendFormattedMessage(
  channelId: string,
  text: string,
  threadTs?: string,
): Promise<void> {
  const cleaned = cleanLLMResponse(text);
  if (!cleaned) return;

  const mrkdwn = markdownToMrkdwn(cleaned);
  const chunks = splitMessage(mrkdwn);

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i]!;

    try {
      await app.client.chat.postMessage({
        channel: channelId,
        text: chunk,
        thread_ts: threadTs,
      });
    } catch {
      // Fallback: send as plain text
      try {
        const plainChunks = splitMessage(cleaned);
        const plainChunk = plainChunks[i] ?? chunk;
        await app.client.chat.postMessage({
          channel: channelId,
          text: plainChunk,
          thread_ts: threadTs,
        });
      } catch (fallbackErr) {
        const error = fallbackErr instanceof Error ? fallbackErr : new Error(String(fallbackErr));
        console.error(`[bridge-slack] Failed to send message chunk ${i + 1}/${chunks.length}:`, error.message);
      }
    }

    // Small delay between chunks to respect Slack rate limits (~1 req/sec for chat.postMessage)
    if (i < chunks.length - 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
}

// ---------------------------------------------------------------------------
// Connection status logging
// ---------------------------------------------------------------------------

socketClient.on('connected', () => {
  console.log('[bridge-slack] Connected to gateway');
});

socketClient.on('disconnected', () => {
  console.log('[bridge-slack] Disconnected from gateway — will reconnect');
});

// ---------------------------------------------------------------------------
// Start everything
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  console.log('[bridge-slack] Starting Slack Bridge...');

  // Connect to gateway socket (auto-reconnects)
  socketClient.connect();

  // Start the Bolt app (Socket Mode)
  await app.start();
  console.log('[bridge-slack] Slack Bridge is running (Socket Mode)');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[bridge-slack] Shutting down...');
    await app.stop();
    socketClient.disconnect();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[bridge-slack] Fatal error:', err);
  process.exit(1);
});
