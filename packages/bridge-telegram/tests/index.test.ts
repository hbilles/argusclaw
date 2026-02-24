import { describe, it, expect, vi, beforeEach } from 'vitest';

// Pre-setup environment variables
process.env.TELEGRAM_BOT_TOKEN = 'fake-token';
process.env.ALLOWED_USER_IDS = '123,456';

// 1. Mock dependencies BEFORE importing index.ts
const mockBotApi = {
  sendMessage: vi.fn().mockResolvedValue({ message_id: 999 }),
  editMessageText: vi.fn().mockResolvedValue(true),
};

const mockBotInstance = {
  command: vi.fn(),
  hears: vi.fn(),
  on: vi.fn(),
  api: mockBotApi,
  start: vi.fn(),
  stop: vi.fn(),
};

vi.mock('grammy', () => {
  return {
    Bot: function () { return mockBotInstance; },
    InlineKeyboard: function () {
      return {
        text: vi.fn().mockReturnThis(),
        row: vi.fn().mockReturnThis(),
      };
    },
  };
});

const mockSocketSend = vi.fn();
const mockSocketOn = vi.fn();

vi.mock('@argusclaw/shared', () => {
  return {
    SocketClient: function () {
      return {
        connected: true,
        send: mockSocketSend,
        on: mockSocketOn,
        connect: vi.fn().mockResolvedValue(undefined),
        disconnect: vi.fn(),
      };
    }
  };
});

// We need to use dynamic import because top-level code executes immediately
describe('Telegram Bridge Index', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation((() => { }) as any);
  });

  it('registers expected commands and event handlers on start', async () => {
    await import('../src/index.js');

    // Check that command handlers were registered
    expect(mockBotInstance.command).toHaveBeenCalledWith('memories', expect.any(Function));
    expect(mockBotInstance.command).toHaveBeenCalledWith('forget', expect.any(Function));
    expect(mockBotInstance.command).toHaveBeenCalledWith('sessions', expect.any(Function));
    expect(mockBotInstance.command).toHaveBeenCalledWith('stop', expect.any(Function));
    expect(mockBotInstance.command).toHaveBeenCalledWith('connect', expect.any(Function));

    // Check that message handlers were registered
    expect(mockBotInstance.on).toHaveBeenCalledWith('message:text', expect.any(Function));
    expect(mockBotInstance.on).toHaveBeenCalledWith('callback_query:data', expect.any(Function));

    // Check that socket handlers were registered
    expect(mockSocketOn).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('forwards allowed text messages to the socket', async () => {
    await import('../src/index.js');

    // Find the message handler
    const messageHandlerCall = mockBotInstance.on.mock.calls.find(call => call[0] === 'message:text')!;
    expect(messageHandlerCall).toBeDefined();

    const handler = messageHandlerCall[1];

    // Simulate an allowed user sending a message
    const ctx = {
      from: { id: 123, first_name: 'Alice' },
      chat: { id: 789 },
      message: { message_id: 111, text: 'Hello bot', date: Date.now() / 1000 },
      reply: vi.fn(),
    };

    await handler(ctx);

    // It should have forwarded over the socket interface
    expect(mockSocketSend).toHaveBeenCalledTimes(1);
    const sentReq = mockSocketSend.mock.calls[0][0];
    expect(sentReq.message.content).toBe('Hello bot');
    expect(sentReq.message.userId).toBe('123');
  });

  it('ignores messages from non-allowed users', async () => {
    await import('../src/index.js');
    const messageHandlerCall = mockBotInstance.on.mock.calls.find(call => call[0] === 'message:text')!;
    const handler = messageHandlerCall[1];

    const ctx = {
      from: { id: 999, first_name: 'Eve' }, // Not in allowlist
      chat: { id: 789 },
      message: { message_id: 222, text: 'Malicious payload', date: Date.now() / 1000 },
    };

    await handler(ctx);

    expect(mockSocketSend).not.toHaveBeenCalled();
  });

  it('handles socket approval-request by sending a telegram message', async () => {
    await import('../src/index.js');
    const socketHandlerCall = mockSocketOn.mock.calls.find(call => call[0] === 'message')!;
    const socketHandler = socketHandlerCall[1];

    await socketHandler({
      type: 'approval-request',
      approvalId: 'req-1',
      toolName: 'my_tool',
      toolInput: '{}',
      chatId: '789'
    });

    expect(mockBotApi.sendMessage).toHaveBeenCalledWith(
      '789',
      expect.stringContaining('Approval Required'),
      expect.any(Object)
    );
  });
});
