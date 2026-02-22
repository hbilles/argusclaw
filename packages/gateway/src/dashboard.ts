/**
 * Web Dashboard — localhost-only web interface for SecureClaw.
 *
 * Serves the chat UI and admin panels, plus REST/SSE API endpoints:
 * - GET  /                         → Main HTML page (static)
 * - POST /api/chat                 → Send message, returns per-request SSE stream
 * - POST /api/chat/reset           → Reset web session
 * - GET  /api/chat/history         → Chat history for page reload
 * - POST /api/approvals/:id/decide → Submit approval decision
 * - GET  /api/audit                → Audit log entries (paginated)
 * - GET  /api/audit/stream         → SSE live audit stream
 * - GET  /api/memories             → All memories
 * - GET  /api/sessions             → Task sessions
 * - GET  /api/approvals            → Approval queue
 * - GET  /api/config               → Current config (read-only)
 *
 * CRITICAL: Bound to 127.0.0.1 ONLY. Rejects non-localhost requests.
 * No authentication needed (localhost-only on your machine).
 */

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AuditLogger } from './audit.js';
import type { MemoryStore } from './memory.js';
import type { ApprovalStore } from './approval-store.js';
import type { SecureClawConfig } from './config.js';
import type { Orchestrator } from './orchestrator.js';
import type { SessionManager } from './session.js';
import type { HITLGate } from './hitl-gate.js';
import type { TaskLoop } from './loop.js';
import type { ChatMessage } from './llm-provider.js';
import { isComplexRequest, readBody, extractTextFromContent } from './utils.js';

const DASHBOARD_PORT = 3333;
const DASHBOARD_HOST = process.env['DASHBOARD_HOST'] || '127.0.0.1';
const WEB_USER_ID = 'web-user';
const WEB_CHAT_ID = 'web';

// ---------------------------------------------------------------------------
// Dashboard Dependencies
// ---------------------------------------------------------------------------

export interface DashboardDeps {
  auditLogger: AuditLogger;
  memoryStore: MemoryStore;
  approvalStore: ApprovalStore;
  config: SecureClawConfig;
  orchestrator: Orchestrator;
  sessionManager: SessionManager;
  hitlGate: HITLGate;
  taskLoop: TaskLoop;
}

// ---------------------------------------------------------------------------
// SSE Client Management
// ---------------------------------------------------------------------------

const sseClients: Set<http.ServerResponse> = new Set();

/**
 * Send an event to all connected SSE clients.
 */
export function broadcastSSE(event: string, data: unknown): void {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.write(message);
    } catch {
      sseClients.delete(client);
    }
  }
}

// ---------------------------------------------------------------------------
// Dashboard Server
// ---------------------------------------------------------------------------

export function startDashboard(deps: DashboardDeps): http.Server | null {
  try {
    const server = http.createServer(async (req, res) => {
      // Security: reject non-localhost requests.
      const remoteAddr = req.socket.remoteAddress ?? '';
      const isLocalhost = remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
      const isDockerBridge = DASHBOARD_HOST === '0.0.0.0' && (
        remoteAddr.startsWith('172.') || remoteAddr.startsWith('::ffff:172.')
      );
      if (!isLocalhost && !isDockerBridge) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden: Dashboard is localhost-only');
        return;
      }

      // CORS headers for local development
      res.setHeader('Access-Control-Allow-Origin', 'http://localhost:3333');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url || '/', `http://${req.headers.host}`);

      try {
        await handleRequest(url, req, res, deps);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        console.error('[dashboard] Request error:', error.message);
        if (!res.headersSent) {
          res.writeHead(500, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
        }
      }
    });

    server.listen(DASHBOARD_PORT, DASHBOARD_HOST, () => {
      console.log(`[dashboard] Web dashboard running at http://${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
    });

    server.on('error', (err) => {
      console.warn(`[dashboard] Failed to start: ${err.message}`);
    });

    return server;
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.warn(`[dashboard] Failed to start: ${error.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Request Handler
// ---------------------------------------------------------------------------

async function handleRequest(
  url: URL,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: DashboardDeps,
): Promise<void> {
  const pathname = url.pathname;

  // ---- Chat API endpoints ----

  if (req.method === 'POST' && pathname === '/api/chat') {
    await handleChat(req, res, deps);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/chat/reset') {
    const session = deps.sessionManager.get(WEB_USER_ID);
    if (session) {
      deps.sessionManager.setMessages(WEB_USER_ID, []);
    }
    sendJSON(res, { ok: true });
    return;
  }

  if (pathname === '/api/chat/history') {
    const session = deps.sessionManager.get(WEB_USER_ID);
    const messages = (session?.messages ?? []).map((m) => ({
      role: m.role,
      content: extractTextFromContent(m.content),
    }));
    sendJSON(res, { messages, sessionId: session?.id });
    return;
  }

  // Approval decision endpoint: POST /api/approvals/:id/decide
  const approvalMatch = pathname.match(/^\/api\/approvals\/([^/]+)\/decide$/);
  if (req.method === 'POST' && approvalMatch) {
    await handleApprovalDecide(req, res, approvalMatch[1]!, deps);
    return;
  }

  // ---- Existing admin API endpoints ----

  if (pathname === '/api/audit') {
    handleAuditAPI(url, res);
    return;
  }

  if (pathname === '/api/audit/stream') {
    handleAuditStream(req, res);
    return;
  }

  if (pathname === '/api/memories') {
    const memories = deps.memoryStore.getAll();
    sendJSON(res, memories);
    return;
  }

  if (pathname === '/api/sessions') {
    const userId = url.searchParams.get('userId');
    if (userId) {
      const sessions = deps.memoryStore.getRecentSessions(userId, 50);
      sendJSON(res, sessions);
    } else {
      const sessions = deps.memoryStore.getAllRecentSessions(50);
      sendJSON(res, sessions);
    }
    return;
  }

  if (pathname === '/api/approvals') {
    const approvals = deps.approvalStore.getRecent(50);
    sendJSON(res, approvals);
    return;
  }

  if (pathname === '/api/config') {
    const sanitized = {
      llm: deps.config.llm,
      executors: {
        shell: { ...deps.config.executors.shell },
        file: { ...deps.config.executors.file },
        web: { ...deps.config.executors.web },
      },
      mounts: deps.config.mounts.map((m) => ({
        name: m.name,
        containerPath: m.containerPath,
        readOnly: m.readOnly,
      })),
      actionTiers: deps.config.actionTiers,
      trustedDomains: deps.config.trustedDomains,
      heartbeats: deps.config.heartbeats,
    };
    sendJSON(res, sanitized);
    return;
  }

  // Static file serving
  serveStatic(pathname, res);
}

// ---------------------------------------------------------------------------
// Chat API
// ---------------------------------------------------------------------------

/** Track whether the web user is currently processing a message. */
let chatBusy = false;

async function handleChat(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  deps: DashboardDeps,
): Promise<void> {
  const body = await readBody(req);
  let content: string;
  try {
    const parsed = JSON.parse(body);
    content = parsed.content;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  if (!content || typeof content !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Missing content field' }));
    return;
  }

  if (chatBusy) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'A message is already being processed' }));
    return;
  }

  chatBusy = true;

  // Set SSE headers for per-request streaming
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  const sendEvent = (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnected
    }
  };

  const session = deps.sessionManager.getOrCreate(WEB_USER_ID);

  // Log message received
  deps.auditLogger.logMessageReceived(session.id, {
    userId: WEB_USER_ID,
    content,
    source: 'web',
  });

  sendEvent('chat:thinking', { status: 'processing' });

  // Register audit hook scoped to this session for streaming events
  const unhook = deps.auditLogger.addHook((entry) => {
    if (entry['sessionId'] !== session.id) return;
    const type = entry['type'] as string;

    if (type === 'tool_call') {
      sendEvent('chat:tool_call', entry['data']);
    } else if (type === 'tool_result') {
      sendEvent('chat:tool_result', entry['data']);
    } else if (type === 'approval_requested') {
      sendEvent('chat:approval_request', entry['data']);
    } else if (type === 'approval_resolved') {
      sendEvent('chat:approval_resolved', entry['data']);
    }
  });

  try {
    // Check for active task session
    const activeTaskSession = deps.memoryStore.getActiveSession(WEB_USER_ID);

    if (!activeTaskSession && isComplexRequest(content)) {
      // Complex request → task loop
      console.log(`[dashboard] Complex request detected — starting task loop`);

      const loopResult = await deps.taskLoop.execute(
        WEB_USER_ID,
        content,
        WEB_CHAT_ID,
        session.id,
      );

      sendEvent('chat:message', {
        role: 'assistant',
        content: loopResult.text,
      });

      deps.auditLogger.logMessageSent(session.id, {
        chatId: WEB_CHAT_ID,
        contentLength: loopResult.text.length,
        taskSessionId: loopResult.sessionId,
        iterations: loopResult.iterations,
        completed: loopResult.completed,
      });
    } else {
      // Normal conversation
      const chatMessages = session.messages.map((m) => ({
        role: m.role,
        content: m.content,
      })) as ChatMessage[];

      chatMessages.push({ role: 'user', content });

      const result = await deps.orchestrator.chat(
        session.id,
        chatMessages,
        WEB_CHAT_ID,
        WEB_USER_ID,
      );

      // Handle [CONTINUE] marker
      if (result.text.includes('[CONTINUE]')) {
        const cleanText = result.text.replace('[CONTINUE]', '').trim();

        deps.sessionManager.setMessages(
          WEB_USER_ID,
          result.messages as Array<{ role: 'user' | 'assistant'; content: unknown }>,
        );

        sendEvent('chat:message', {
          role: 'assistant',
          content: cleanText,
        });

        // Start task loop for continuation
        const loopResult = await deps.taskLoop.execute(
          WEB_USER_ID,
          content,
          WEB_CHAT_ID,
          session.id,
        );

        sendEvent('chat:message', {
          role: 'assistant',
          content: loopResult.text,
        });
      } else {
        // Normal response
        deps.sessionManager.setMessages(
          WEB_USER_ID,
          result.messages as Array<{ role: 'user' | 'assistant'; content: unknown }>,
        );

        sendEvent('chat:message', {
          role: 'assistant',
          content: result.text,
        });

        deps.auditLogger.logMessageSent(session.id, {
          chatId: WEB_CHAT_ID,
          contentLength: result.text.length,
        });
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[dashboard] Chat error:', error.message);

    deps.auditLogger.logError(session.id, {
      error: error.message,
      stack: error.stack,
    });

    sendEvent('chat:error', { error: error.message });
  } finally {
    unhook();
    chatBusy = false;
    sendEvent('chat:done', {});
    res.end();
  }
}

// ---------------------------------------------------------------------------
// Approval Decision API
// ---------------------------------------------------------------------------

async function handleApprovalDecide(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  approvalId: string,
  deps: DashboardDeps,
): Promise<void> {
  const body = await readBody(req);
  let decision: 'approved' | 'rejected' | 'session-approved';
  try {
    const parsed = JSON.parse(body);
    decision = parsed.decision;
  } catch {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid JSON body' }));
    return;
  }

  if (!['approved', 'rejected', 'session-approved'].includes(decision)) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Invalid decision value' }));
    return;
  }

  deps.hitlGate.resolveApproval(approvalId, decision);
  sendJSON(res, { ok: true, approvalId, decision });
}

// ---------------------------------------------------------------------------
// Audit API
// ---------------------------------------------------------------------------

function handleAuditAPI(url: URL, res: http.ServerResponse): void {
  const date = url.searchParams.get('date') || new Date().toISOString().split('T')[0]!;
  const type = url.searchParams.get('type');
  const sessionId = url.searchParams.get('sessionId');
  const limit = parseInt(url.searchParams.get('limit') || '200', 10);

  const auditDir = process.env['AUDIT_DIR'] || '/data/audit';
  const filePath = path.join(auditDir, `audit-${date}.jsonl`);

  if (!fs.existsSync(filePath)) {
    sendJSON(res, []);
    return;
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  let entries = content
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter((entry): entry is Record<string, unknown> => entry !== null);

  if (type) {
    entries = entries.filter((e) => e['type'] === type);
  }
  if (sessionId) {
    entries = entries.filter((e) => e['sessionId'] === sessionId);
  }

  entries = entries.reverse().slice(0, limit);
  sendJSON(res, entries);
}

// ---------------------------------------------------------------------------
// SSE Audit Stream
// ---------------------------------------------------------------------------

function handleAuditStream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): void {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
  });

  res.write(`event: connected\ndata: {"time":"${new Date().toISOString()}"}\n\n`);

  sseClients.add(res);

  req.on('close', () => {
    sseClients.delete(res);
  });
}

// ---------------------------------------------------------------------------
// Static File Serving
// ---------------------------------------------------------------------------

const STATIC_DIR = path.resolve(__dirname, '../public');

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'application/javascript',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

function serveStatic(pathname: string, res: http.ServerResponse): void {
  if (pathname === '/') pathname = '/index.html';

  // Prevent path traversal
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(STATIC_DIR, safePath);

  // Ensure the resolved path is within STATIC_DIR
  if (!filePath.startsWith(STATIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
    return;
  }

  const ext = path.extname(filePath);
  const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

  const content = fs.readFileSync(filePath);
  res.writeHead(200, { 'Content-Type': mimeType });
  res.end(content);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sendJSON(res: http.ServerResponse, data: unknown): void {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}
