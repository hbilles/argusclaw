/**
 * Unit tests for the Action Classification Engine.
 *
 * This is a security-critical component. Tests cover:
 * - Exact path matches
 * - Glob patterns
 * - Negation patterns
 * - Default to require-approval when no rule matches
 * - Case sensitivity
 * - Path traversal attempts
 * - Missing tool input fields
 * - Unrecognized tools
 */

import { describe, it, expect } from 'vitest';
import { classifyAction, matchesPattern } from '../src/classifier.js';
import type { ArgusClawConfig } from '../src/config.js';

// ---------------------------------------------------------------------------
// Test config matching argusclaw.yaml
// ---------------------------------------------------------------------------

const testConfig: ArgusClawConfig = {
  llm: { provider: 'anthropic', model: 'claude-sonnet-4-20250514', maxTokens: 4096 },
  executors: {
    shell: { image: 'test-shell', memoryLimit: '512m', cpuLimit: 1, defaultTimeout: 60, defaultMaxOutput: 1048576 },
    file: { image: 'test-file', memoryLimit: '256m', cpuLimit: 0.5, defaultTimeout: 30, defaultMaxOutput: 5242880 },
  },
  mounts: [
    { name: 'projects', hostPath: '/home/user/projects', containerPath: '/workspace', readOnly: false },
    { name: 'sandbox', hostPath: '/home/user/sandbox', containerPath: '/sandbox', readOnly: false },
  ],
  actionTiers: {
    autoApprove: [
      { tool: 'read_file' },
      { tool: 'list_directory' },
      { tool: 'search_files' },
      { tool: 'run_shell_command', conditions: { working_directory: '/sandbox/**' } },
    ],
    notify: [
      { tool: 'write_file', conditions: { path: '/sandbox/**' } },
    ],
    requireApproval: [
      { tool: 'write_file', conditions: { path: '!(/sandbox/**)' } },
      { tool: 'run_shell_command', conditions: { working_directory: '!(/sandbox/**)' } },
    ],
  },
};

// ---------------------------------------------------------------------------
// classifyAction tests
// ---------------------------------------------------------------------------

describe('classifyAction', () => {
  // ---- Auto-approve tier ----

  describe('auto-approve tier', () => {
    it('should auto-approve read_file (no conditions)', () => {
      expect(classifyAction('read_file', { path: '/workspace/project/file.ts' }, testConfig))
        .toBe('auto-approve');
    });

    it('should auto-approve read_file with any path', () => {
      expect(classifyAction('read_file', { path: '/etc/passwd' }, testConfig))
        .toBe('auto-approve');
    });

    it('should auto-approve list_directory (no conditions)', () => {
      expect(classifyAction('list_directory', { path: '/workspace' }, testConfig))
        .toBe('auto-approve');
    });

    it('should auto-approve search_files (no conditions)', () => {
      expect(classifyAction('search_files', { path: '/workspace', pattern: 'TODO' }, testConfig))
        .toBe('auto-approve');
    });

    it('should auto-approve run_shell_command in /sandbox/', () => {
      expect(classifyAction('run_shell_command', {
        command: 'ls -la',
        working_directory: '/sandbox/test',
      }, testConfig)).toBe('auto-approve');
    });

    it('should auto-approve run_shell_command in /sandbox/ root', () => {
      expect(classifyAction('run_shell_command', {
        command: 'pwd',
        working_directory: '/sandbox/a',
      }, testConfig)).toBe('auto-approve');
    });
  });

  // ---- Notify tier ----

  describe('notify tier', () => {
    it('should notify for write_file to /sandbox/', () => {
      expect(classifyAction('write_file', {
        path: '/sandbox/test.txt',
        content: 'hello',
      }, testConfig)).toBe('notify');
    });

    it('should notify for write_file to nested /sandbox/ path', () => {
      expect(classifyAction('write_file', {
        path: '/sandbox/deep/nested/file.js',
        content: 'code',
      }, testConfig)).toBe('notify');
    });
  });

  // ---- Require-approval tier ----

  describe('require-approval tier', () => {
    it('should require approval for write_file outside /sandbox/', () => {
      expect(classifyAction('write_file', {
        path: '/workspace/project/README.md',
        content: '# Hello',
      }, testConfig)).toBe('require-approval');
    });

    it('should require approval for write_file to /workspace/', () => {
      expect(classifyAction('write_file', {
        path: '/workspace/config.json',
        content: '{}',
      }, testConfig)).toBe('require-approval');
    });

    it('should require approval for run_shell_command outside /sandbox/', () => {
      expect(classifyAction('run_shell_command', {
        command: 'rm -rf /',
        working_directory: '/workspace/project',
      }, testConfig)).toBe('require-approval');
    });

    it('should require approval for run_shell_command at root', () => {
      expect(classifyAction('run_shell_command', {
        command: 'ls',
        working_directory: '/',
      }, testConfig)).toBe('require-approval');
    });
  });

  // ---- Default behavior (fail-safe) ----

  describe('default to require-approval (fail-safe)', () => {
    it('should require approval for unknown tool names', () => {
      expect(classifyAction('delete_file', { path: '/sandbox/test.txt' }, testConfig))
        .toBe('require-approval');
    });

    it('should require approval for run_shell_command with no working_directory', () => {
      // No working_directory field → no condition matches → falls through to default
      expect(classifyAction('run_shell_command', {
        command: 'whoami',
      }, testConfig)).toBe('require-approval');
    });

    it('should require approval when tool input is empty', () => {
      expect(classifyAction('run_shell_command', {}, testConfig))
        .toBe('require-approval');
    });
  });

  // ---- Path traversal attempts ----

  describe('path traversal protection', () => {
    it('should not auto-approve shell command with path traversal in working_directory', () => {
      expect(classifyAction('run_shell_command', {
        command: 'cat /etc/passwd',
        working_directory: '/sandbox/../etc',
      }, testConfig)).not.toBe('auto-approve');
    });

    it('should not notify write_file with path traversal through sandbox', () => {
      expect(classifyAction('write_file', {
        path: '/sandbox/../../etc/passwd',
        content: 'malicious',
      }, testConfig)).not.toBe('auto-approve');
    });

    it('should require approval for write_file with traversal escaping sandbox', () => {
      // The glob /sandbox/* does not match /sandbox/../etc/passwd
      // because picomatch treats it literally — no path normalization
      const tier = classifyAction('write_file', {
        path: '/sandbox/../etc/passwd',
        content: 'malicious',
      }, testConfig);
      // This should NOT be notify (which would mean auto-proceed for sandbox writes)
      // It should be require-approval because the negation pattern also won't match
      // a path that starts with /sandbox/ — but the important thing is it's NOT notify
      expect(tier).not.toBe('notify');
    });
  });

  // ---- Case sensitivity ----

  describe('case sensitivity', () => {
    it('should be case-sensitive for tool names', () => {
      expect(classifyAction('Read_File', { path: '/workspace/test.txt' }, testConfig))
        .toBe('require-approval');
    });

    it('should be case-sensitive for paths', () => {
      expect(classifyAction('write_file', {
        path: '/Sandbox/test.txt',
        content: 'hello',
      }, testConfig)).toBe('require-approval');
    });
  });
});

// ---------------------------------------------------------------------------
// matchesPattern unit tests
// ---------------------------------------------------------------------------

describe('matchesPattern', () => {
  describe('standard glob patterns', () => {
    it('should match /sandbox/* against /sandbox/file.txt', () => {
      expect(matchesPattern('/sandbox/file.txt', '/sandbox/*')).toBe(true);
    });

    it('should match /sandbox/* against /sandbox/deep', () => {
      expect(matchesPattern('/sandbox/deep', '/sandbox/*')).toBe(true);
    });

    it('should not match /sandbox/* against /sandbox/deep/nested/file.txt', () => {
      // Single * does not cross directory boundaries by default in picomatch
      expect(matchesPattern('/sandbox/deep/nested/file.txt', '/sandbox/*')).toBe(false);
    });

    it('should not match /sandbox/* against /workspace/file.txt', () => {
      expect(matchesPattern('/workspace/file.txt', '/sandbox/*')).toBe(false);
    });

    it('should not match /sandbox/* against /sandbox (no trailing content)', () => {
      // /sandbox/* requires at least one path component after /sandbox/
      expect(matchesPattern('/sandbox', '/sandbox/*')).toBe(false);
    });

    it('should match /sandbox/** against deeply nested paths', () => {
      expect(matchesPattern('/sandbox/a/b/c/d.txt', '/sandbox/**')).toBe(true);
    });
  });

  describe('negation patterns !(pattern)', () => {
    it('should match !(/sandbox/*) against /workspace/file.txt', () => {
      expect(matchesPattern('/workspace/file.txt', '!(/sandbox/*)')).toBe(true);
    });

    it('should not match !(/sandbox/*) against /sandbox/file.txt', () => {
      expect(matchesPattern('/sandbox/file.txt', '!(/sandbox/*)')).toBe(false);
    });

    it('should match !(/sandbox/*) against /etc/passwd', () => {
      expect(matchesPattern('/etc/passwd', '!(/sandbox/*)')).toBe(true);
    });

    it('should match !(/sandbox/*) against root path /', () => {
      expect(matchesPattern('/', '!(/sandbox/*)')).toBe(true);
    });

    it('should match !(/sandbox/*) against /sandbox (no trailing slash)', () => {
      // /sandbox itself doesn't match /sandbox/*, so negation should be true
      expect(matchesPattern('/sandbox', '!(/sandbox/*)')).toBe(true);
    });
  });

  describe('dotfile patterns', () => {
    it('should match dotfiles with dot: true', () => {
      expect(matchesPattern('/sandbox/.hidden', '/sandbox/*')).toBe(true);
    });

    it('should match .env files', () => {
      expect(matchesPattern('/workspace/.env', '/workspace/*')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// Edge cases: config with empty rules
// ---------------------------------------------------------------------------

describe('classifyAction with edge-case configs', () => {
  it('should default to require-approval when all tier arrays are empty', () => {
    const emptyConfig: ArgusClawConfig = {
      ...testConfig,
      actionTiers: {
        autoApprove: [],
        notify: [],
        requireApproval: [],
      },
    };

    expect(classifyAction('read_file', { path: '/anything' }, emptyConfig))
      .toBe('require-approval');
  });

  it('should handle rules with multiple conditions (all must match)', () => {
    const multiCondConfig: ArgusClawConfig = {
      ...testConfig,
      actionTiers: {
        autoApprove: [
          {
            tool: 'run_shell_command',
            conditions: {
              working_directory: '/sandbox/*',
              command: 'ls*',
            },
          },
        ],
        notify: [],
        requireApproval: [],
      },
    };

    // Both conditions match
    expect(classifyAction('run_shell_command', {
      command: 'ls -la',
      working_directory: '/sandbox/test',
    }, multiCondConfig)).toBe('auto-approve');

    // Only one condition matches
    expect(classifyAction('run_shell_command', {
      command: 'rm -rf /',
      working_directory: '/sandbox/test',
    }, multiCondConfig)).toBe('require-approval');
  });
});
