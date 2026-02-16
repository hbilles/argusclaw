/**
 * SecureClaw Gateway — central orchestrator.
 *
 * Listens on a Unix domain socket for messages from bridges,
 * manages sessions, routes tool calls through sandboxed containers,
 * and logs everything to the audit trail.
 *
 * Phase 3: Added the HITL approval gate. Tool calls are now classified
 * into tiers (auto-approve / notify / require-approval) based on config.
 * Dangerous actions require explicit user approval via Telegram inline buttons.
 */

import Anthropic from '@anthropic-ai/sdk';
import { SocketServer } from '@secureclaw/shared';
import type {
  SocketRequest,
  SocketResponse,
  ApprovalDecision,
} from '@secureclaw/shared';
import { SessionManager } from './session.js';
import { AuditLogger } from './audit.js';
import { loadConfig } from './config.js';
import { Dispatcher } from './dispatcher.js';
import { Orchestrator } from './orchestrator.js';
import { ApprovalStore } from './approval-store.js';
import { HITLGate } from './hitl-gate.js';

async function main(): Promise<void> {
  console.log('[gateway] Starting SecureClaw Gateway...');

  // Load configuration
  const config = loadConfig();

  // Initialize components
  const sessionManager = new SessionManager();
  const auditLogger = new AuditLogger();
  await auditLogger.init();

  // Initialize the approval store (SQLite)
  const approvalStore = new ApprovalStore();

  // Start periodic expiry checks (every 60s, expire after 5 minutes)
  approvalStore.startExpiryCheck();

  // Initialize the dispatcher (Docker container manager)
  // This requires /var/run/docker.sock to be mounted
  const dispatcher = new Dispatcher(config);

  // Check Docker connectivity
  const dockerAvailable = await dispatcher.ping();
  if (dockerAvailable) {
    console.log('[gateway] Docker daemon is accessible');
  } else {
    console.warn(
      '[gateway] WARNING: Docker daemon is not accessible. ' +
      'Tool execution will fail. Ensure /var/run/docker.sock is mounted.',
    );
  }

  const socketServer = new SocketServer();

  // Initialize the HITL gate (approval system)
  // The sendToBridge callback broadcasts to all connected bridge clients
  const hitlGate = new HITLGate(
    approvalStore,
    auditLogger,
    config,
    (message) => socketServer.broadcast(message),
  );

  // Initialize the orchestrator (agentic tool-use loop)
  const orchestrator = new Orchestrator(dispatcher, hitlGate, auditLogger, config);

  // Handle incoming messages from bridges
  socketServer.on('message', async (data: unknown, reply: (response: unknown) => void, clientId: string) => {
    const raw = data as Record<string, unknown>;

    // --- Phase 3: Handle approval decisions from bridge ---
    if (raw['type'] === 'approval-decision') {
      const decision = data as ApprovalDecision;
      console.log(
        `[gateway] Approval decision: ${decision.approvalId} → ${decision.decision}`,
      );
      hitlGate.resolveApproval(decision.approvalId, decision.decision);
      return;
    }

    // --- Standard message request from bridge ---
    const request = data as SocketRequest;

    if (!request.requestId || !request.message) {
      console.error('[gateway] Invalid request from client', clientId);
      return;
    }

    const { requestId, message, replyTo } = request;
    const { userId, content } = message;

    // Get or create session
    const session = sessionManager.getOrCreate(userId);

    try {
      // 1. Log message received
      auditLogger.logMessageReceived(session.id, {
        requestId,
        userId,
        content,
        source: message.source,
        sourceId: message.sourceId,
      });

      // 2. Build the messages array from session history
      //    Cast to Anthropic format — the session stores messages in a
      //    compatible format (role + content where content is string or block array).
      const chatMessages = session.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })) as Anthropic.Messages.MessageParam[];

      // 3. Append the new user message
      chatMessages.push({
        role: 'user',
        content,
      });

      // 4. Run the orchestrator (agentic tool-use loop)
      //    Pass the chatId so the HITL gate can send approval requests
      //    and notifications to the correct Telegram chat.
      console.log(
        `[gateway] Processing message for session ${session.id} ` +
        `(${chatMessages.length} messages in context)`,
      );

      const result = await orchestrator.chat(session.id, chatMessages, replyTo.chatId);

      // 5. Store the updated messages in the session
      //    This includes all intermediate tool_use / tool_result messages.
      sessionManager.setMessages(
        userId,
        result.messages as Array<{ role: 'user' | 'assistant'; content: unknown }>,
      );

      // 6. Send the final text response back to the bridge
      const socketResponse: SocketResponse = {
        requestId,
        outgoing: {
          chatId: replyTo.chatId,
          content: result.text,
          replyToId: replyTo.messageId,
        },
      };

      reply(socketResponse);

      // 7. Log message sent
      auditLogger.logMessageSent(session.id, {
        requestId,
        chatId: replyTo.chatId,
        contentLength: result.text.length,
      });

      console.log(
        `[gateway] Response sent for request ${requestId} (${result.text.length} chars)`,
      );

    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      console.error(`[gateway] Error processing request ${requestId}:`, error.message);

      auditLogger.logError(session.id, {
        requestId,
        error: error.message,
        stack: error.stack,
      });

      // Send error response back to bridge so the user gets feedback
      const errorResponse: SocketResponse = {
        requestId,
        outgoing: {
          chatId: replyTo.chatId,
          content: 'Sorry, I encountered an error processing your message. Please try again.',
          replyToId: replyTo.messageId,
        },
      };

      reply(errorResponse);
    }
  });

  // Start the socket server
  await socketServer.start();
  console.log('[gateway] Gateway is ready.');

  // Graceful shutdown
  const shutdown = async () => {
    console.log('[gateway] Shutting down...');
    await socketServer.stop();
    sessionManager.dispose();
    auditLogger.close();
    approvalStore.close();
    process.exit(0);
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[gateway] Fatal error:', err);
  process.exit(1);
});
