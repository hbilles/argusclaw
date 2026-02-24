import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { MemoryStore } from '../src/memory.js';

describe('MemoryStore', () => {
  let store: MemoryStore;

  beforeEach(() => {
    // Use an in-memory SQLite database for testing to avoid touching disk
    store = new MemoryStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('Long-term Memory', () => {
    it('saves and retrieves a memory', () => {
      const mem = store.save('user', 'Name', 'Alice');
      expect(mem.category).toBe('user');
      expect(mem.topic).toBe('Name');
      expect(mem.content).toBe('Alice');

      const retrieved = store.getByCategory('user');
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].content).toBe('Alice');
    });

    it('upserts memory when category and topic match', () => {
      store.save('preference', 'Color', 'Blue');
      store.save('preference', 'Color', 'Red');

      const retrieved = store.getByCategory('preference');
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].content).toBe('Red');
    });

    it('performs full-text search', () => {
      store.save('fact', 'Project Argus', 'A very secret project about a claw');
      store.save('fact', 'Project Beta', 'Something else entirely');

      const results = store.search('secret project claw');
      expect(results.length).toBeGreaterThan(0);
      expect(results[0].topic).toBe('Project Argus');
    });

    it('updates access count on search', () => {
      store.save('fact', 'Test', 'Data');
      expect(store.getByCategory('fact')[0].accessCount).toBe(0);

      store.search('Data');
      expect(store.getByCategory('fact')[0].accessCount).toBe(1);
    });

    it('deletes memory by id', () => {
      const mem = store.save('user', 'Temp', 'Data');
      expect(store.deleteById(mem.id)).toBe(true);
      expect(store.getByCategory('user')).toHaveLength(0);
    });

    it('deletes memory by topic', () => {
      store.save('user', 'TempTopic', 'Data');
      expect(store.deleteByTopic('TempTopic')).toBe(true);
      expect(store.getByCategory('user')).toHaveLength(0);
    });
  });

  describe('Task Sessions', () => {
    it('creates and retrieves active session', () => {
      const session = store.createSession('user1', 'Do a task');
      expect(session.userId).toBe('user1');
      expect(session.status).toBe('active');
      expect(session.originalRequest).toBe('Do a task');

      const active = store.getActiveSession('user1');
      expect(active).toBeDefined();
      expect(active!.id).toBe(session.id);
    });

    it('updates session plan', () => {
      const session = store.createSession('user1', 'Task');
      const plan = { goal: 'Win', steps: [], assumptions: [], log: [] };
      store.updateSession(session.id, plan, 1);

      const updated = store.getSessionById(session.id);
      expect(updated!.plan).toEqual(plan);
      expect(updated!.iteration).toBe(1);
    });

    it('completes session', () => {
      const session = store.createSession('user1', 'Task');
      store.completeSession(session.id, 'completed');

      const active = store.getActiveSession('user1');
      expect(active).toBeNull(); // No longer active

      const updated = store.getSessionById(session.id);
      expect(updated!.status).toBe('completed');
    });

    it('cancels active session', () => {
      store.createSession('user1', 'Task');
      const canceledId = store.cancelActiveSession('user1');
      expect(canceledId).toBeDefined();

      const active = store.getActiveSession('user1');
      expect(active).toBeNull();
    });
  });
});
