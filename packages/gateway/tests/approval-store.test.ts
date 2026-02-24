import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { ApprovalStore, type CreateApprovalInput } from '../src/approval-store.js';

describe('ApprovalStore', () => {
  let store: ApprovalStore;

  const sampleInput: CreateApprovalInput = {
    id: 'app-1',
    sessionId: 'session-1',
    toolName: 'run_shell_command',
    toolInput: '{"command":"ls"}',
    capability: '{"action":"execute"}',
    reason: 'To see files',
    planContext: 'Looking around',
    createdAt: new Date().toISOString(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    store = new ApprovalStore(':memory:');
  });

  afterEach(() => {
    store.close();
    vi.useRealTimers();
  });

  it('creates and retrieves a pending approval', () => {
    const created = store.create(sampleInput);
    expect(created.status).toBe('pending');
    expect(created.id).toBe('app-1');

    const retrieved = store.getById('app-1');
    expect(retrieved).toBeDefined();
    expect(retrieved!.status).toBe('pending');
    expect(retrieved!.toolName).toBe('run_shell_command');
  });

  it('returns undefined for non-existent approval', () => {
    expect(store.getById('non-existent')).toBeUndefined();
  });

  it('resolves an approval', () => {
    store.create(sampleInput);
    store.resolve('app-1', 'approved');

    const retrieved = store.getById('app-1');
    expect(retrieved!.status).toBe('approved');
    expect(retrieved!.resolvedAt).toBeDefined();
  });

  it('expires stale pending approvals', () => {
    const input = { ...sampleInput, createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
    store.create(input);

    const expiredCount = store.expireStalePending(5 * 60 * 1000);
    expect(expiredCount).toBe(1);

    const retrieved = store.getById('app-1');
    expect(retrieved!.status).toBe('expired');
  });

  it('does not expire fresh pending approvals', () => {
    store.create(sampleInput);

    const expiredCount = store.expireStalePending(5 * 60 * 1000);
    expect(expiredCount).toBe(0);

    const retrieved = store.getById('app-1');
    expect(retrieved!.status).toBe('pending');
  });

  it('does not expire already resolved approvals', () => {
    const input = { ...sampleInput, createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() };
    store.create(input);
    store.resolve('app-1', 'approved');

    const expiredCount = store.expireStalePending(5 * 60 * 1000);
    expect(expiredCount).toBe(0);

    const retrieved = store.getById('app-1');
    expect(retrieved!.status).toBe('approved');
  });

  it('retrieves recent approvals ordered by descending createdAt', () => {
    store.create({ ...sampleInput, id: 'app-old', createdAt: new Date(Date.now() - 1000).toISOString() });
    store.create({ ...sampleInput, id: 'app-new', createdAt: new Date().toISOString() });

    const recent = store.getRecent(10);
    expect(recent.length).toBe(2);
    expect(recent[0].id).toBe('app-new');
    expect(recent[1].id).toBe('app-old');
  });
});
