import { describe, it, expect, vi, beforeEach } from 'vitest';

process.env.SLACK_BOT_TOKEN = 'fake-bot-token';
process.env.SLACK_APP_TOKEN = 'fake-app-token';
process.env.SLACK_ALLOWED_USER_IDS = 'U123,U456';

const mockChatClient = {
  postMessage: vi.fn().mockResolvedValue({ ts: '1000' }),
  update: vi.fn().mockResolvedValue({ ts: '1000' }),
};

const mockAppInstance = {
  command: vi.fn(),
  event: vi.fn(),
  action: vi.fn(),
  client: {
    chat: mockChatClient,
  },
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn(), // If shutdown gets added later
};

vi.mock('@slack/bolt', () => {
  return {
    App: function () { return mockAppInstance; },
    LogLevel: { WARN: 'warn' },
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

describe('Slack Bridge Index', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(process, 'exit').mockImplementation((() => { }) as any);
  });

  it('registers expected commands and event handlers on start', async () => {
    await import('../src/index.js');

    // Commands
    expect(mockAppInstance.command).toHaveBeenCalledWith('/argus_memories', expect.any(Function));
    expect(mockAppInstance.command).toHaveBeenCalledWith('/argus_forget', expect.any(Function));
    expect(mockAppInstance.command).toHaveBeenCalledWith('/argus_sessions', expect.any(Function));
    expect(mockAppInstance.command).toHaveBeenCalledWith('/argus_stop', expect.any(Function));
    expect(mockAppInstance.command).toHaveBeenCalledWith('/argus_connect', expect.any(Function));

    // Events
    expect(mockAppInstance.event).toHaveBeenCalledWith('app_mention', expect.any(Function));
    expect(mockAppInstance.event).toHaveBeenCalledWith('message', expect.any(Function));

    // Actions
    expect(mockAppInstance.action).toHaveBeenCalledWith('approve_action', expect.any(Function));
    expect(mockAppInstance.action).toHaveBeenCalledWith('reject_action', expect.any(Function));

    // Socket
    expect(mockSocketOn).toHaveBeenCalledWith('message', expect.any(Function));
  });

  it('forwards allowed DMs to the socket', async () => {
    await import('../src/index.js');

    const messageEventCall = mockAppInstance.event.mock.calls.find(c => c[0] === 'message')!;
    const handler = messageEventCall[1];

    const ctx = {
      event: {
        channel_type: 'im',
        user: 'U123',
        channel: 'D123',
        text: 'Hello socket',
        ts: '123456.789'
      }
    };

    await handler(ctx);

    expect(mockSocketSend).toHaveBeenCalledTimes(1);
    const sentReq = mockSocketSend.mock.calls[0][0];
    expect(sentReq.message.content).toBe('Hello socket');
    expect(sentReq.message.userId).toBe('U123');
  });

  it('ignores messages from non-allowed users', async () => {
    await import('../src/index.js');
    const messageEventCall = mockAppInstance.event.mock.calls.find(c => c[0] === 'message')!;
    const handler = messageEventCall[1];

    const ctx = {
      event: {
        channel_type: 'im',
        user: 'U999', // Not allowed
        channel: 'D123',
        text: 'Malicious',
        ts: '123456.789'
      }
    };

    await handler(ctx);
    expect(mockSocketSend).not.toHaveBeenCalled();
  });

  it('handles socket approval-request by posting a slack message with blocks', async () => {
    await import('../src/index.js');
    const socketHandlerCall = mockSocketOn.mock.calls.find(c => c[0] === 'message')!;
    const socketHandler = socketHandlerCall[1];

    await socketHandler({
      type: 'approval-request',
      approvalId: 'slk-req-1',
      toolName: 'ssh_access',
      toolInput: '{}',
      chatId: 'slack:C123'
    });

    expect(mockChatClient.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'C123',
        blocks: expect.arrayContaining([
          expect.objectContaining({ type: 'actions' })
        ])
      })
    );
  });
});
