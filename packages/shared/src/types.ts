/**
 * Core types for the SecureClaw framework.
 */

/** Internal message format — all bridges convert to/from this */
export interface Message {
  id: string;                           // UUID
  sourceId: string;                     // Original platform message ID
  source: 'telegram';                   // Extensible later
  userId: string;                       // Platform user ID (for allowlist checking)
  content: string;                      // Text content
  timestamp: Date;
  metadata?: Record<string, unknown>;   // Platform-specific extras
}

/** What we send back to the bridge */
export interface OutgoingMessage {
  chatId: string;                       // Platform chat ID to reply to
  content: string;
  replyToId?: string;                   // Optional: reply to specific message
}

/**
 * Session — conversation state.
 *
 * Messages can contain simple text or complex content blocks (e.g., tool use).
 * The `content` field is typed as `unknown` to support Anthropic's message
 * format (string | ContentBlock[]) without coupling to the Anthropic SDK.
 */
export interface Session {
  id: string;
  userId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>;
  createdAt: Date;
  updatedAt: Date;
}

/** Audit log entry */
export interface AuditEntry {
  timestamp: Date;
  type:
    | 'message_received'
    | 'llm_request'
    | 'llm_response'
    | 'message_sent'
    | 'error'
    | 'tool_call'
    | 'tool_result'
    | 'action_classified'
    | 'approval_requested'
    | 'approval_resolved';
  sessionId: string;
  data: Record<string, unknown>;
}

/** Executor result — returned by sandboxed executor containers */
export interface ExecutorResult {
  success: boolean;
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
  error?: string;
}

/** Socket request — bridge sends this to gateway */
export interface SocketRequest {
  requestId: string;
  message: Message;
  replyTo: { chatId: string; messageId?: string };
}

/** Socket response — gateway sends this back to bridge */
export interface SocketResponse {
  requestId: string;
  outgoing: OutgoingMessage;
}

// ---------------------------------------------------------------------------
// Phase 3: HITL Approval Protocol
// ---------------------------------------------------------------------------

/** Action classification tiers */
export type ActionTier = 'auto-approve' | 'notify' | 'require-approval';

/** Approval request — gateway sends to bridge for user confirmation */
export interface ApprovalRequest {
  type: 'approval-request';
  approvalId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  reason: string;
  planContext?: string;
  chatId: string;
}

/** Approval decision — bridge sends to gateway after user taps inline button */
export interface ApprovalDecision {
  type: 'approval-decision';
  approvalId: string;
  decision: 'approved' | 'rejected';
}

/** Notification — gateway sends to bridge for informational messages */
export interface BridgeNotification {
  type: 'notification';
  chatId: string;
  text: string;
}

/** Approval expired — gateway tells bridge to update the Telegram message */
export interface ApprovalExpired {
  type: 'approval-expired';
  approvalId: string;
  chatId: string;
}

/** Union of all gateway → bridge message types */
export type GatewayToBridgeMessage =
  | SocketResponse
  | ApprovalRequest
  | BridgeNotification
  | ApprovalExpired;

/** Union of all bridge → gateway message types */
export type BridgeToGatewayMessage =
  | SocketRequest
  | ApprovalDecision;
