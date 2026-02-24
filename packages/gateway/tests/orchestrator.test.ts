import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Orchestrator } from '../src/orchestrator.js';
import type { LLMProvider, ChatMessage, LLMResponse } from '../src/llm-provider.js';
import type { Dispatcher } from '../src/dispatcher.js';
import type { ExecutorResult } from '@argusclaw/shared';
import type { HITLGate, GateResult } from '../src/hitl-gate.js';
import type { AuditLogger } from '../src/audit.js';
import type { ArgusClawConfig } from '../src/config.js';
import type { MemoryStore, Memory } from '../src/memory.js';

describe('Orchestrator Integration', () => {
  let mockProvider: LLMProvider;
  let mockDispatcher: Dispatcher;
  let mockHitlGate: HITLGate;
  let mockAuditLogger: AuditLogger;
  let mockConfig: ArgusClawConfig;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    mockProvider = {
      chat: vi.fn(),
    };

    mockDispatcher = {
      execute: vi.fn(),
      getStats: vi.fn(),
    } as unknown as Dispatcher;

    mockHitlGate = {
      gate: vi.fn(),
      getPendingApproval: vi.fn(),
      resolveApproval: vi.fn(),
      getPendingCount: vi.fn(),
    } as unknown as HITLGate;

    mockAuditLogger = {
      logLLMRequest: vi.fn(),
      logLLMResponse: vi.fn(),
      logToolCall: vi.fn(),
      logToolResult: vi.fn(),
      logSoulEvent: vi.fn(),
    } as unknown as AuditLogger;

    mockConfig = {
      llm: { model: 'test-model', maxTokens: 1000 },
      executors: {
        shell: { defaultMaxOutput: 1000 },
        file: { defaultMaxOutput: 1000 },
        web: { resultFormat: 'compact', defaultMaxOutput: 1000 },
      },
    } as unknown as ArgusClawConfig;

    orchestrator = new Orchestrator(
      mockProvider,
      mockDispatcher,
      mockHitlGate,
      mockAuditLogger,
      mockConfig
    );
  });

  it('handles a simple chat request without tool calls', async () => {
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'Hello, world!' }],
      usage: { inputTokens: 10, outputTokens: 10 },
    });

    const messages: ChatMessage[] = [{ role: 'user', content: 'Hi' }];
    const result = await orchestrator.chat('session-1', messages, 'chat-1', 'user-1');

    expect(result.text).toBe('Hello, world!');
    expect(result.messages.length).toBe(2);
    expect(result.messages[1].role).toBe('assistant');

    // Audit logged
    expect(mockAuditLogger.logLLMRequest).toHaveBeenCalledTimes(1);
    expect(mockAuditLogger.logLLMResponse).toHaveBeenCalledTimes(1);
  });

  it('handles a tool call that is approved and returns successfully', async () => {
    // Loop step 1: LLM decides to call a tool
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      stopReason: 'tool_use',
      content: [
        { type: 'text', text: 'Let me list the files.' },
        { type: 'tool_call', id: 'call_1', name: 'list_directory', input: { path: '/workspace' } }
      ],
      usage: { inputTokens: 10, outputTokens: 10 },
    });

    // Loop step 2: LLM receives tool result and produces final answer
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'Here are the files: file1.txt, file2.txt' }],
      usage: { inputTokens: 40, outputTokens: 20 },
    });

    // Gateway approves the tool call
    vi.mocked(mockHitlGate.gate).mockResolvedValueOnce({
      proceed: true,
      tier: 'auto-approve',
      approvalId: 'req-1',
    });

    // Dispatcher returns simulated execution success
    vi.mocked(mockDispatcher.execute).mockResolvedValueOnce({
      success: true,
      stdout: 'file1.txt\nfile2.txt',
      stderr: '',
      exitCode: 0,
      durationMs: 100,
    });

    const messages: ChatMessage[] = [{ role: 'user', content: 'What files are there?' }];
    const result = await orchestrator.chat('sess-2', messages, 'chat-2', 'user-2');

    expect(result.text).toBe('Here are the files: file1.txt, file2.txt');
    expect(mockDispatcher.execute).toHaveBeenCalledWith('file', { operation: 'list', params: { path: '/workspace' } });

    // Final history length should reflect: user -> LLM(tool_call) -> tool_result -> LLM(final)
    expect(result.messages.length).toBe(4);
    expect(result.messages[1].role).toBe('assistant');
    expect(result.messages[2].role).toBe('tool_results');
    expect(result.messages[3].role).toBe('assistant');
  });

  it('handles a tool call that is rejected by HITL Gate', async () => {
    // LLM attempts a command
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      stopReason: 'tool_use',
      content: [
        { type: 'tool_call', id: 'call_rm', name: 'run_shell_command', input: { command: 'rm -rf /' } }
      ],
      usage: { inputTokens: 10, outputTokens: 10 },
    });

    // LLM receives rejection text and replies safely
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'I understand, I will not do that.' }],
      usage: { inputTokens: 20, outputTokens: 15 },
    });

    // Gateway REJECTS the tool call
    vi.mocked(mockHitlGate.gate).mockResolvedValueOnce({
      proceed: false,
      tier: 'require-approval',
      approvalId: 'req-danger',
    });

    const messages: ChatMessage[] = [{ role: 'user', content: 'Delete everything.' }];
    const result = await orchestrator.chat('sess-3', messages, 'chat-3', 'user-3');

    expect(result.text).toBe('I understand, I will not do that.');
    expect(mockDispatcher.execute).not.toHaveBeenCalled();

    const toolResultsMessage = result.messages.find(m => m.role === 'tool_results') as any;
    expect(toolResultsMessage).toBeDefined();
    expect(toolResultsMessage.content[0].content).toContain('rejected by the user');
  });

  it('handles built-in memory tools locally without dispatcher or hitlGate', async () => {
    // Setup memory store mock
    const mockMemoryStore = {
      save: vi.fn().mockImplementation((category, topic, content) => ({ category, topic, content })),
      search: vi.fn(),
    } as unknown as MemoryStore;

    // Attach memory
    orchestrator.setMemory(mockMemoryStore, null as any);

    // LLM attempts to save a memory
    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      stopReason: 'tool_use',
      content: [
        { type: 'tool_call', id: 'call_mem', name: 'save_memory', input: { category: 'user', topic: 'name', content: 'Alice' } }
      ],
      usage: { inputTokens: 10, outputTokens: 10 },
    });

    vi.mocked(mockProvider.chat).mockResolvedValueOnce({
      stopReason: 'end_turn',
      content: [{ type: 'text', text: 'Got it, I will remember!' }],
      usage: { inputTokens: 20, outputTokens: 15 },
    });

    const messages: ChatMessage[] = [{ role: 'user', content: 'My name is Alice.' }];
    const result = await orchestrator.chat('sess-4', messages, 'chat-4', 'user-4');

    expect(result.text).toBe('Got it, I will remember!');
    expect(mockHitlGate.gate).not.toHaveBeenCalled(); // Memory doesn't bypass... wait, the logic DOES skip HITL gate.
    expect(mockMemoryStore.save).toHaveBeenCalledWith('user', 'name', 'Alice');
  });

  it('stops early if MAX_ITERATIONS is reached (to prevent infinite loops)', async () => {
    // Keep returning tool_use indefinitely
    vi.mocked(mockProvider.chat).mockResolvedValue({
      stopReason: 'tool_use',
      content: [
        { type: 'tool_call', id: 'loop_1', name: 'list_directory', input: { path: '/' } }
      ],
      usage: { inputTokens: 10, outputTokens: 10 },
    });

    vi.mocked(mockHitlGate.gate).mockResolvedValue({
      proceed: true,
      tier: 'auto-approve',
      approvalId: 'req-loop',
    });

    vi.mocked(mockDispatcher.execute).mockResolvedValue({
      success: true,
      stdout: 'loop',
      stderr: '',
      exitCode: 0,
      durationMs: 10,
    });

    const messages: ChatMessage[] = [{ role: 'user', content: 'Do a loop.' }];
    const result = await orchestrator.chat('sess-5', messages, 'chat-5', 'user-5');

    // Should abort after 10 loops
    expect(result.text).toContain('maximum number of tool call iterations');
    expect(mockProvider.chat).toHaveBeenCalledTimes(10);
  });
});
