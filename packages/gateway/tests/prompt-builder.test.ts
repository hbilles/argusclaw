import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PromptBuilder } from '../src/prompt-builder.js';
import type { MemoryStore, Memory, TaskSession } from '../src/memory.js';
import type { SoulManager } from '../src/soul.js';
import type { SkillsManager, SkillCatalogEntry } from '../src/skills.js';

describe('PromptBuilder', () => {
  let mockMemoryStore: Partial<MemoryStore>;
  let mockSoulManager: Partial<SoulManager>;
  let mockSkillsManager: Partial<SkillsManager>;
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

    mockSkillsManager = {
      getCatalog: vi.fn().mockReturnValue([
        { name: 'git-workflow', description: 'Standard git workflow' },
        { name: 'code-review', description: 'Code review checklist' },
      ] as SkillCatalogEntry[]),
      getAlwaysLoadContent: vi.fn().mockReturnValue([]),
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

    it('omits skills section when no skills manager is set', () => {
      const prompt = promptBuilder.buildSystemPrompt('hello', 'user1');
      expect(prompt).not.toContain('## Skills');
      expect(prompt).not.toContain('load_skill');
    });

    it('includes skills catalog when skills manager is set', () => {
      promptBuilder.setSkillsManager(mockSkillsManager as SkillsManager);
      const prompt = promptBuilder.buildSystemPrompt('hello', 'user1');
      expect(prompt).toContain('## Skills');
      expect(prompt).toContain('git-workflow');
      expect(prompt).toContain('Standard git workflow');
      expect(prompt).toContain('code-review');
      expect(prompt).toContain('load_skill');
    });

    it('omits skills section when catalog is empty', () => {
      mockSkillsManager.getCatalog = vi.fn().mockReturnValue([]);
      promptBuilder.setSkillsManager(mockSkillsManager as SkillsManager);
      const prompt = promptBuilder.buildSystemPrompt('hello', 'user1');
      expect(prompt).not.toContain('## Skills');
    });

    it('includes alwaysLoad skill content inline', () => {
      mockSkillsManager.getAlwaysLoadContent = vi.fn().mockReturnValue([
        { name: 'git-workflow', content: '# Git Workflow\n\nAlways loaded instructions.' },
      ]);
      promptBuilder.setSkillsManager(mockSkillsManager as SkillsManager);
      const prompt = promptBuilder.buildSystemPrompt('hello', 'user1');
      expect(prompt).toContain('### Skill: git-workflow');
      expect(prompt).toContain('Always loaded instructions.');
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

    it('includes skills catalog in loop prompt', () => {
      promptBuilder.setSkillsManager(mockSkillsManager as SkillsManager);
      const session: TaskSession = {
        userId: 'user1',
        originalRequest: 'loop task',
        status: 'in-progress',
        iteration: 1,
        maxIterations: 5,
        plan: { goal: 'Goal', steps: [], assumptions: [], log: [] },
      };

      const prompt = promptBuilder.buildLoopPrompt(session, 'user1');
      expect(prompt).toContain('## Skills');
      expect(prompt).toContain('git-workflow');
    });
  });
});

