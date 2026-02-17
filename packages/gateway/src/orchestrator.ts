/**
 * Orchestrator — manages the agentic tool-use loop with the LLM.
 *
 * Flow:
 * 1. Send user message + tool definitions to Claude
 * 2. If Claude responds with tool_use blocks:
 *    a. Gate each tool call through the HITL system (classify + approve)
 *    b. If approved, route through the Dispatcher (sandboxed container)
 *    c. If rejected, return rejection message to the LLM
 *    d. Send tool results back to Claude
 *    e. Repeat until Claude responds with text (no more tool calls)
 * 3. Return the final text response + full message history
 *
 * Safety: max 10 iterations to prevent infinite tool-call loops.
 *
 * Phase 3: Tool calls now go through the HITL gate for classification
 * and potential approval before execution. The LLM never sees the tier
 * system — it only sees tool results (success or rejection).
 *
 * Phase 4: Added memory tools (save_memory, search_memory), prompt builder
 * integration for memory-aware system prompts, and [CONTINUE] detection
 * for the Ralph Wiggum loop.
 */

import Anthropic from '@anthropic-ai/sdk';
import type { Dispatcher } from './dispatcher.js';
import type { HITLGate } from './hitl-gate.js';
import type { ExecutorResult } from '@secureclaw/shared';
import type { AuditLogger } from './audit.js';
import type { SecureClawConfig } from './config.js';
import type { MemoryStore, MemoryCategory } from './memory.js';
import type { PromptBuilder } from './prompt-builder.js';

// ---------------------------------------------------------------------------
// Tool Definitions for the Anthropic API
// ---------------------------------------------------------------------------

const EXECUTOR_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'run_shell_command',
    description:
      'Run a shell command in a sandboxed container. Use for: running scripts, ' +
      'git operations, package management, data processing. The command runs in ' +
      'an isolated Docker container with no network access and limited filesystem visibility.',
    input_schema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          description: 'The shell command to execute',
        },
        working_directory: {
          type: 'string',
          description: 'Working directory path (must be within mounted volumes)',
        },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the contents of a file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Absolute path to the file',
        },
        content: {
          type: 'string',
          description: 'Content to write',
        },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories at a path.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Directory path to list',
        },
      },
      required: ['path'],
    },
  },
  {
    name: 'search_files',
    description: 'Search for a pattern in files using ripgrep.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: {
          type: 'string',
          description: 'Directory to search in',
        },
        pattern: {
          type: 'string',
          description: 'Search pattern (regex supported)',
        },
      },
      required: ['path', 'pattern'],
    },
  },
];

/** Memory tools — always auto-approve tier (safe operations). */
const MEMORY_TOOLS: Anthropic.Messages.Tool[] = [
  {
    name: 'save_memory',
    description:
      'Save information to long-term memory for future conversations. Use for: ' +
      'user preferences, project context, important facts, environment details. ' +
      'If a memory with the same topic and category already exists, it will be updated.',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          enum: ['user', 'project', 'preference', 'fact', 'environment'],
          description: 'Category of the memory',
        },
        topic: {
          type: 'string',
          description: 'Short key for this memory (e.g., "coding style", "project:secureclaw")',
        },
        content: {
          type: 'string',
          description: 'The information to remember, in clear prose',
        },
      },
      required: ['category', 'topic', 'content'],
    },
  },
  {
    name: 'search_memory',
    description: 'Search your memories for relevant information.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'What to search for',
        },
      },
      required: ['query'],
    },
  },
];

/** All tools combined. */
const ALL_TOOLS: Anthropic.Messages.Tool[] = [...EXECUTOR_TOOLS, ...MEMORY_TOOLS];

/** Set of memory tool names (for auto-approve bypass). */
const MEMORY_TOOL_NAMES = new Set(MEMORY_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/** Maximum number of LLM ↔ tool iterations before stopping. */
const MAX_ITERATIONS = 10;

export class Orchestrator {
  private client: Anthropic;
  private dispatcher: Dispatcher;
  private hitlGate: HITLGate;
  private auditLogger: AuditLogger;
  private config: SecureClawConfig;
  private memoryStore: MemoryStore | null = null;
  private promptBuilder: PromptBuilder | null = null;

  constructor(
    dispatcher: Dispatcher,
    hitlGate: HITLGate,
    auditLogger: AuditLogger,
    config: SecureClawConfig,
  ) {
    // The Anthropic SDK reads ANTHROPIC_API_KEY from env automatically
    this.client = new Anthropic();
    this.dispatcher = dispatcher;
    this.hitlGate = hitlGate;
    this.auditLogger = auditLogger;
    this.config = config;
  }

  /** Attach the memory store and prompt builder (Phase 4). */
  setMemory(memoryStore: MemoryStore, promptBuilder: PromptBuilder): void {
    this.memoryStore = memoryStore;
    this.promptBuilder = promptBuilder;
  }

  /**
   * Process a conversation with tool-use support.
   *
   * Runs the agentic loop: LLM → tool calls → LLM → ... → final text.
   * Uses the prompt builder for memory-aware system prompts.
   *
   * @param sessionId - For audit logging
   * @param messages - Conversation history (Anthropic MessageParam format)
   * @param chatId - Telegram chat ID for sending notifications / approval requests
   * @param userId - User ID for memory retrieval (optional for backward compat)
   * @returns The final text response and the updated messages array
   */
  async chat(
    sessionId: string,
    messages: Anthropic.Messages.MessageParam[],
    chatId: string,
    userId?: string,
  ): Promise<{ text: string; messages: Anthropic.Messages.MessageParam[] }> {
    // Build the system prompt using the prompt builder if available
    let systemPrompt: string;
    if (this.promptBuilder && userId) {
      const lastUserMsg = [...messages].reverse().find((m) => m.role === 'user');
      const userText = typeof lastUserMsg?.content === 'string'
        ? lastUserMsg.content
        : '';
      systemPrompt = this.promptBuilder.buildSystemPrompt(userText, userId);
    } else {
      systemPrompt = this.getDefaultSystemPrompt();
    }

    return this.runLoop(sessionId, messages, chatId, systemPrompt);
  }

  /**
   * Process a conversation with a custom system prompt.
   * Used by the Ralph Wiggum loop to provide session-aware prompts.
   */
  async chatWithSystemPrompt(
    sessionId: string,
    messages: Anthropic.Messages.MessageParam[],
    chatId: string,
    systemPrompt: string,
  ): Promise<{ text: string; messages: Anthropic.Messages.MessageParam[] }> {
    return this.runLoop(sessionId, messages, chatId, systemPrompt);
  }

  // -------------------------------------------------------------------------
  // Core Loop
  // -------------------------------------------------------------------------

  private async runLoop(
    sessionId: string,
    messages: Anthropic.Messages.MessageParam[],
    chatId: string,
    systemPrompt: string,
  ): Promise<{ text: string; messages: Anthropic.Messages.MessageParam[] }> {
    const workingMessages = [...messages];
    let iterations = 0;

    while (iterations < MAX_ITERATIONS) {
      iterations++;

      // Call the LLM with tool definitions
      this.auditLogger.logLLMRequest(sessionId, {
        iteration: iterations,
        messageCount: workingMessages.length,
        toolsEnabled: true,
      });

      const response = await this.client.messages.create({
        model: this.config.llm.model,
        max_tokens: this.config.llm.maxTokens,
        system: systemPrompt,
        tools: ALL_TOOLS,
        messages: workingMessages,
      });

      this.auditLogger.logLLMResponse(sessionId, {
        iteration: iterations,
        stopReason: response.stop_reason,
        contentBlocks: response.content.length,
        usage: response.usage,
      });

      // If the LLM wants to use tools, process each tool call
      if (response.stop_reason === 'tool_use') {
        // Append the full assistant response (includes both text and tool_use blocks)
        workingMessages.push({
          role: 'assistant',
          content: response.content,
        });

        // Extract text blocks as the LLM's reasoning/explanation
        const textBlocks = response.content.filter(
          (block): block is Anthropic.Messages.TextBlock =>
            block.type === 'text',
        );
        const assistantReason = textBlocks.map((b) => b.text).join(' ').trim();

        // Get the most recent user message for plan context
        const lastUserMsg = [...workingMessages]
          .reverse()
          .find((m) => m.role === 'user');
        const planContext = typeof lastUserMsg?.content === 'string'
          ? lastUserMsg.content
          : undefined;

        // Extract tool_use blocks
        const toolUseBlocks = response.content.filter(
          (block): block is Anthropic.Messages.ToolUseBlock =>
            block.type === 'tool_use',
        );

        // Process each tool call through the HITL gate, then dispatch
        const toolResults: Anthropic.Messages.ToolResultBlockParam[] = [];

        for (const toolUse of toolUseBlocks) {
          const input = toolUse.input as Record<string, unknown>;
          const reason = assistantReason || `Executing ${toolUse.name}`;

          console.log(
            `[orchestrator] Tool call: ${toolUse.name}(${JSON.stringify(input).slice(0, 200)})`,
          );

          // Audit the tool call
          this.auditLogger.logToolCall(sessionId, {
            toolCallId: toolUse.id,
            toolName: toolUse.name,
            input,
          });

          // Memory tools are handled locally, not through HITL or dispatcher
          if (MEMORY_TOOL_NAMES.has(toolUse.name)) {
            const result = this.handleMemoryTool(toolUse.name, input);

            this.auditLogger.logToolResult(sessionId, {
              toolCallId: toolUse.id,
              toolName: toolUse.name,
              tier: 'auto-approve',
              success: true,
            });

            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: result,
            });
            continue;
          }

          // Gate the tool call through the HITL system
          const gateResult = await this.hitlGate.gate({
            sessionId,
            toolName: toolUse.name,
            toolInput: input,
            chatId,
            reason,
            planContext,
          });

          let resultContent: string;

          if (gateResult.proceed) {
            // Approved — execute the tool
            const result = await this.dispatchToolCall(toolUse.name, input);

            // Audit the result
            this.auditLogger.logToolResult(sessionId, {
              toolCallId: toolUse.id,
              toolName: toolUse.name,
              tier: gateResult.tier,
              success: result.success,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              outputLength: result.stdout.length,
              error: result.error,
            });

            resultContent = result.success
              ? result.stdout
              : `Error: ${result.error ?? result.stderr}\nStderr: ${result.stderr}`;

            resultContent = resultContent.slice(
              0,
              this.config.executors.file.defaultMaxOutput,
            );

            console.log(
              `[orchestrator] Tool result: ${toolUse.name} → ${result.success ? 'success' : 'error'} (${result.durationMs}ms, tier: ${gateResult.tier})`,
            );
          } else {
            // Rejected — tell the LLM the user declined
            resultContent = `Action rejected by the user. The user declined to approve: ${toolUse.name}. Please adjust your approach or ask the user how they would like to proceed.`;

            this.auditLogger.logToolResult(sessionId, {
              toolCallId: toolUse.id,
              toolName: toolUse.name,
              tier: gateResult.tier,
              success: false,
              rejected: true,
              approvalId: gateResult.approvalId,
            });

            console.log(
              `[orchestrator] Tool rejected: ${toolUse.name} (approval: ${gateResult.approvalId})`,
            );
          }

          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: resultContent,
          });
        }

        // Append tool results as a user message
        workingMessages.push({
          role: 'user',
          content: toolResults,
        });

        // Continue the loop — LLM will process the tool results

      } else {
        // No tool use — extract the final text response
        const text = response.content
          .filter(
            (block): block is Anthropic.Messages.TextBlock =>
              block.type === 'text',
          )
          .map((block) => block.text)
          .join('');

        // Append the final assistant text
        workingMessages.push({
          role: 'assistant',
          content: text,
        });

        return { text, messages: workingMessages };
      }
    }

    // Safety: if we hit the iteration limit, return what we have
    console.warn(`[orchestrator] Hit max iterations (${MAX_ITERATIONS}) for session ${sessionId}`);
    return {
      text: 'I reached the maximum number of tool call iterations. Please try again with a simpler request.',
      messages: workingMessages,
    };
  }

  // -------------------------------------------------------------------------
  // Memory Tool Handling
  // -------------------------------------------------------------------------

  /**
   * Handle memory tools locally (no HITL gate, no dispatcher).
   * These are safe operations that don't need approval.
   */
  private handleMemoryTool(toolName: string, input: Record<string, unknown>): string {
    if (!this.memoryStore) {
      return 'Memory system is not available.';
    }

    switch (toolName) {
      case 'save_memory': {
        const category = input['category'] as MemoryCategory;
        const topic = input['topic'] as string;
        const content = input['content'] as string;

        if (!category || !topic || !content) {
          return 'Error: category, topic, and content are all required.';
        }

        const memory = this.memoryStore.save(category, topic, content);
        return `Memory saved: [${memory.category}] ${memory.topic}`;
      }

      case 'search_memory': {
        const query = input['query'] as string;
        if (!query) {
          return 'Error: query is required.';
        }

        const results = this.memoryStore.search(query, 5);
        if (results.length === 0) {
          return 'No matching memories found.';
        }

        return results
          .map((r) => `[${r.category}] **${r.topic}**: ${r.content}`)
          .join('\n\n');
      }

      default:
        return `Unknown memory tool: ${toolName}`;
    }
  }

  // -------------------------------------------------------------------------
  // Tool Dispatch
  // -------------------------------------------------------------------------

  /**
   * Route a tool call to the appropriate executor type.
   */
  private async dispatchToolCall(
    toolName: string,
    input: Record<string, unknown>,
  ): Promise<ExecutorResult> {
    switch (toolName) {
      case 'run_shell_command':
        return this.dispatcher.execute('shell', {
          command: input['command'] as string,
          workingDir: input['working_directory'] as string | undefined,
        });

      case 'read_file':
        return this.dispatcher.execute('file', {
          operation: 'read',
          params: { path: input['path'] as string },
        });

      case 'write_file':
        return this.dispatcher.execute('file', {
          operation: 'write',
          params: {
            path: input['path'] as string,
            content: input['content'] as string,
          },
        });

      case 'list_directory':
        return this.dispatcher.execute('file', {
          operation: 'list',
          params: { path: input['path'] as string },
        });

      case 'search_files':
        return this.dispatcher.execute('file', {
          operation: 'search',
          params: {
            path: input['path'] as string,
            pattern: input['pattern'] as string,
          },
        });

      default:
        return {
          success: false,
          exitCode: -1,
          stdout: '',
          stderr: `Unknown tool: ${toolName}`,
          durationMs: 0,
          error: `Unknown tool: ${toolName}`,
        };
    }
  }

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  private getDefaultSystemPrompt(): string {
    return (
      'You are SecureClaw, a personal AI assistant with the ability to interact with the ' +
      'filesystem and run shell commands. You have access to tools that run in sandboxed ' +
      'Docker containers with no network access.\n\n' +
      'You can list directories, read and write files, search for patterns, and run shell commands.\n\n' +
      'File paths should use the following mount points:\n' +
      '- /workspace — maps to the user\'s projects directory\n' +
      '- /documents — maps to the user\'s Documents directory (read-only)\n' +
      '- /sandbox — maps to the user\'s sandbox directory (read-write)\n\n' +
      'Be helpful, concise, and direct. You are communicating via Telegram, so keep ' +
      'responses reasonably short unless the user asks for detail. When a user asks ' +
      'about files or directories, use the appropriate tools rather than guessing.'
    );
  }
}
