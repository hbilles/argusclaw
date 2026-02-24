import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SessionManager } from '../src/session.js';

describe('SessionManager', () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    vi.useFakeTimers();
    sessionManager = new SessionManager();
  });

  afterEach(() => {
    sessionManager.dispose();
    vi.useRealTimers();
  });

  it('creates a new session if one does not exist', () => {
    const session = sessionManager.getOrCreate('user1');
    expect(session.userId).toBe('user1');
    expect(session.messages).toEqual([]);
    expect(sessionManager.get('user1')).toBe(session);
  });

  it('returns existing session', () => {
    const session1 = sessionManager.getOrCreate('user1');
    const session2 = sessionManager.getOrCreate('user1');
    expect(session1).toBe(session2);
  });

  it('appends messages and trims to MAX_MESSAGES', () => {
    for (let i = 0; i < 55; i++) {
      sessionManager.append('user1', 'user', `Message ${i}`);
    }
    const session = sessionManager.get('user1')!;
    expect(session.messages.length).toBe(50); // MAX_MESSAGES is 50
    expect(session.messages[0]).toEqual({ role: 'user', content: 'Message 5' });
    expect(session.messages[49]).toEqual({ role: 'user', content: 'Message 54' });
  });

  it('setMessages replaces messages and trims', () => {
    const messages = Array.from({ length: 60 }).map((_, i) => ({ role: 'user' as const, content: `Msg ${i}` }));
    sessionManager.setMessages('user1', messages);

    const session = sessionManager.get('user1')!;
    expect(session.messages.length).toBe(50);
    expect(session.messages[0]).toEqual({ role: 'user', content: 'Msg 10' });
  });

  it('cleans up expired sessions', () => {
    const session = sessionManager.getOrCreate('user1');
    session.updatedAt = new Date(Date.now() - 61 * 60 * 1000);

    // Advance timers just enough to trigger cleanup interval
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(sessionManager.get('user1')).toBeUndefined();
  });

  it('calls onSessionExpired when session is cleaned up', () => {
    const onExpired = vi.fn();
    sessionManager.onSessionExpired = onExpired;

    const session = sessionManager.getOrCreate('user1');
    session.updatedAt = new Date(Date.now() - 61 * 60 * 1000);

    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(onExpired).toHaveBeenCalledWith('user1');
  });

  it('keeps active sessions during cleanup', () => {
    const session = sessionManager.getOrCreate('user1');

    // Set timestamp to 59 minutes ago (not quite expired)
    session.updatedAt = new Date(Date.now() - 59 * 60 * 1000);

    // Activity updates timestamp to now
    sessionManager.append('user1', 'user', 'Ping');

    // Trigger cleanup
    vi.advanceTimersByTime(5 * 60 * 1000);

    expect(sessionManager.get('user1')).toBeDefined();
  });
});
