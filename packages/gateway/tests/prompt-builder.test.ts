import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptBuilder } from '../src/prompt-builder.js';
import type { MemoryStore, Memory, TaskSession } from '../src/memory.js';
import type { SoulManager } from '../src/soul.js';

describe('PromptBuilder', () => {
  let mockMemoryStore: Partial<MemoryStore>;
  let mockSoulManager: Partial<SoulManager>;
  let promptBuilder: PromptBuilder;

  beforeEach(() => {
    mockMemoryStore = {
      getByCategory: vi.fn().mockReturnValue([]),
      search: vi.fn().mockReturnValue([]),
      getActiveSession: vi.fn().mockReturnValue(null),
    };

    mockSoulManager = {
      getContentSafe: vi.fn().mockReturnValue('Mocked Soul Content.'),
    };

    promptBuilder = new PromptBuilder(mockMemoryStore as MemoryStore);
  });

  describe('buildSystemPrompt', () => {
    it('includes default identity when no soul manager is set', () => {
      const prompt = promptBuilder.buildSystemPrompt('hello', 'user1');
      expect(prompt).toContain('You are a personal AI assistant called ArgusClaw');
    });

    it('includes mocked identity when soul manager is set', () => {
      promptBuilder.setSoulManager(mockSoulManager as SoulManager);
      const prompt = promptBuilder.buildSystemPrompt('hello', 'user1');
      expect(prompt).toContain('Mocked Soul Content.');
    });

    it('includes user and preference memories', () => {
      const m1: Memory = { id: '1', userId: 'user1', category: 'user', topic: 'Name', content: 'Alice', accessCount: 1, createdAt: 1, lastAccessedAt: 1 };
      mockMemoryStore.getByCategory = vi.fn((category: string) => {
        if (category === 'user') return [m1];
        return [];
      });

      const prompt = promptBuilder.buildSystemPrompt('hello', 'user1');
      expect(prompt).toContain('What You Know About the User');
      expect(prompt).toContain('Name');
      expect(prompt).toContain('Alice');
    });

    it('includes relevant context memories from search', () => {
      const m1: Memory = { id: '2', userId: 'user1', category: 'fact', topic: 'Project', content: 'ArgusClaw is cool', accessCount: 1, createdAt: 1, lastAccessedAt: 1 };
      mockMemoryStore.search = vi.fn().mockReturnValue([m1]);

      const prompt = promptBuilder.buildSystemPrompt('hello', 'user1');
      expect(prompt).toContain('Relevant Context');
      expect(prompt).toContain('Project');
      expect(prompt).toContain('ArgusClaw is cool');
    });

    it('includes active session if present', () => {
      const session: TaskSession = {
        userId: 'user1',
        originalRequest: 'do task',
        status: 'in-progress',
        iteration: 1,
        maxIterations: 10,
        plan: { goal: 'Goal', steps: [{ id: '1', description: 'Step 1', status: 'pending', result: null }], assumptions: [], log: [] },
      };
      mockMemoryStore.getActiveSession = vi.fn().mockReturnValue(session);

      const prompt = promptBuilder.buildSystemPrompt('hello', 'user1');
      expect(prompt).toContain('Active Task');
      expect(prompt).toContain('Goal');
    });
  });

  describe('buildLoopPrompt', () => {
    it('includes session information prominently', () => {
      const session: TaskSession = {
        userId: 'user1',
        originalRequest: 'loop task',
        status: 'in-progress',
        iteration: 2,
        maxIterations: 5,
        plan: { goal: 'Loop Goal', steps: [{ id: '1', description: 'Loop Step', status: 'completed', result: 'done' }], assumptions: [], log: [] },
      };

      const prompt = promptBuilder.buildLoopPrompt(session, 'user1');
      expect(prompt).toContain('Active Task');
      expect(prompt).toContain('Loop Goal');
      expect(prompt).toContain('iteration 2/5');
      expect(prompt).toContain('Loop Step');
      expect(prompt).toContain('done');
    });
  });
});
