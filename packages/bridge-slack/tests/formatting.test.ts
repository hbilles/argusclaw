/**
 * Unit tests for Slack bridge formatting and utility functions.
 *
 * Tests cover:
 * - Chat ID namespacing (slackChatId, extractSlackChannel)
 * - Tool display formatting (formatToolSummary)
 * - LLM response cleaning (cleanLLMResponse)
 * - Markdown → Slack mrkdwn conversion (markdownToMrkdwn)
 * - Message chunking (splitMessage)
 */

import { describe, it, expect } from 'vitest';
import {
  slackChatId,
  extractSlackChannel,
  formatToolSummary,
  cleanLLMResponse,
  markdownToMrkdwn,
  splitMessage,
} from '../src/formatting.js';

// ---------------------------------------------------------------------------
// Chat ID helpers
// ---------------------------------------------------------------------------

describe('slackChatId', () => {
  it('should prefix a channel ID with slack:', () => {
    expect(slackChatId('C0123456789')).toBe('slack:C0123456789');
  });

  it('should work with DM channel IDs', () => {
    expect(slackChatId('D0123456789')).toBe('slack:D0123456789');
  });

  it('should handle empty string', () => {
    expect(slackChatId('')).toBe('slack:');
  });
});

describe('extractSlackChannel', () => {
  it('should extract channel ID from slack: prefix', () => {
    expect(extractSlackChannel('slack:C0123456789')).toBe('C0123456789');
  });

  it('should return null for non-Slack chat IDs', () => {
    expect(extractSlackChannel('123456789')).toBeNull();
  });

  it('should return null for web dashboard UUIDs', () => {
    expect(extractSlackChannel('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBeNull();
  });

  it('should return empty string for bare slack: prefix', () => {
    expect(extractSlackChannel('slack:')).toBe('');
  });

  it('should not match partial prefix', () => {
    expect(extractSlackChannel('slackbot:123')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// formatToolSummary
// ---------------------------------------------------------------------------

describe('formatToolSummary', () => {
  it('should format write_file with path', () => {
    expect(formatToolSummary('write_file', { path: '/workspace/test.ts', content: 'code' }))
      .toBe('write_file \u2192 /workspace/test.ts');
  });

  it('should format read_file with path', () => {
    expect(formatToolSummary('read_file', { path: '/workspace/config.json' }))
      .toBe('read_file \u2192 /workspace/config.json');
  });

  it('should format list_directory with path', () => {
    expect(formatToolSummary('list_directory', { path: '/workspace' }))
      .toBe('list_directory \u2192 /workspace');
  });

  it('should format search_files with default path', () => {
    expect(formatToolSummary('search_files', { pattern: 'TODO' }))
      .toBe('search_files \u2192 .');
  });

  it('should format search_files with explicit path', () => {
    expect(formatToolSummary('search_files', { path: '/workspace/src', pattern: 'TODO' }))
      .toBe('search_files \u2192 /workspace/src');
  });

  it('should format run_shell_command with short command', () => {
    expect(formatToolSummary('run_shell_command', { command: 'ls -la' }))
      .toBe('run_shell_command \u2192 `ls -la`');
  });

  it('should truncate long shell commands at 60 chars', () => {
    const longCmd = 'find / -name "*.ts" -exec grep -l "import" {} \\; | sort -u | head -20';
    const result = formatToolSummary('run_shell_command', { command: longCmd });
    expect(result).toContain('...');
    // Verify the truncated command is at most 60 chars + the "..."
    const cmdPart = result.replace('run_shell_command \u2192 `', '').replace('`', '');
    expect(cmdPart.length).toBeLessThanOrEqual(63); // 60 + "..."
  });

  it('should format browse_web with URL and action', () => {
    expect(formatToolSummary('browse_web', { url: 'https://example.com', action: 'extract' }))
      .toBe('browse_web \u2192 https://example.com (extract)');
  });

  it('should format browse_web with default action', () => {
    expect(formatToolSummary('browse_web', { url: 'https://example.com' }))
      .toBe('browse_web \u2192 https://example.com (navigate)');
  });

  it('should handle missing path with fallback', () => {
    expect(formatToolSummary('write_file', { content: 'test' }))
      .toBe('write_file \u2192 unknown');
  });

  it('should return tool name for unknown tools', () => {
    expect(formatToolSummary('custom_tool', { foo: 'bar' }))
      .toBe('custom_tool');
  });

  it('should handle empty command string', () => {
    expect(formatToolSummary('run_shell_command', {}))
      .toBe('run_shell_command \u2192 ``');
  });
});

// ---------------------------------------------------------------------------
// cleanLLMResponse
// ---------------------------------------------------------------------------

describe('cleanLLMResponse', () => {
  it('should strip single <think> block', () => {
    expect(cleanLLMResponse('<think>reasoning here</think>The answer is 42.'))
      .toBe('The answer is 42.');
  });

  it('should strip multiple <think> blocks', () => {
    expect(cleanLLMResponse('<think>first thought</think>Hello <think>second thought</think>world'))
      .toBe('Hello world');
  });

  it('should handle multiline <think> blocks', () => {
    const input = `<think>
Let me think about this...
Step 1: Do X
Step 2: Do Y
</think>
Here is the result.`;
    expect(cleanLLMResponse(input)).toBe('Here is the result.');
  });

  it('should return text unchanged if no <think> tags', () => {
    expect(cleanLLMResponse('Hello, world!')).toBe('Hello, world!');
  });

  it('should trim whitespace', () => {
    expect(cleanLLMResponse('  hello  ')).toBe('hello');
  });

  it('should return empty string for only <think> content', () => {
    expect(cleanLLMResponse('<think>only thinking</think>')).toBe('');
  });

  it('should handle empty string', () => {
    expect(cleanLLMResponse('')).toBe('');
  });

  it('should handle <think> with no content', () => {
    expect(cleanLLMResponse('<think></think>Answer')).toBe('Answer');
  });
});

// ---------------------------------------------------------------------------
// markdownToMrkdwn
// ---------------------------------------------------------------------------

describe('markdownToMrkdwn', () => {
  describe('bold conversion', () => {
    it('should convert **bold** to *bold*', () => {
      expect(markdownToMrkdwn('This is **bold** text')).toBe('This is *bold* text');
    });

    it('should convert __bold__ to *bold*', () => {
      expect(markdownToMrkdwn('This is __bold__ text')).toBe('This is *bold* text');
    });

    it('should handle multiple bold phrases', () => {
      expect(markdownToMrkdwn('**one** and **two**')).toBe('*one* and *two*');
    });
  });

  describe('link conversion', () => {
    it('should convert [text](url) to <url|text>', () => {
      expect(markdownToMrkdwn('[Click here](https://example.com)'))
        .toBe('<https://example.com|Click here>');
    });

    it('should handle multiple links', () => {
      expect(markdownToMrkdwn('[A](https://a.com) and [B](https://b.com)'))
        .toBe('<https://a.com|A> and <https://b.com|B>');
    });
  });

  describe('header conversion', () => {
    it('should convert # header to *header*', () => {
      expect(markdownToMrkdwn('# Title')).toBe('*Title*');
    });

    it('should convert ## header to *header*', () => {
      expect(markdownToMrkdwn('## Subtitle')).toBe('*Subtitle*');
    });

    it('should convert ### header to *header*', () => {
      expect(markdownToMrkdwn('### Section')).toBe('*Section*');
    });

    it('should handle headers at different levels', () => {
      expect(markdownToMrkdwn('###### Deep header')).toBe('*Deep header*');
    });
  });

  describe('code protection', () => {
    it('should preserve inline code unchanged', () => {
      expect(markdownToMrkdwn('Use `**not bold**` here')).toBe('Use `**not bold**` here');
    });

    it('should preserve code blocks unchanged', () => {
      const input = '```\n**not bold**\n```';
      const result = markdownToMrkdwn(input);
      expect(result).toContain('**not bold**');
      expect(result).toContain('```');
    });

    it('should preserve code blocks with language specifier', () => {
      const input = '```typescript\nconst x = 1;\n```';
      const result = markdownToMrkdwn(input);
      expect(result).toContain('const x = 1;');
      expect(result).toContain('```');
    });

    it('should not convert bold inside inline code', () => {
      expect(markdownToMrkdwn('Run `npm run **test**` to test'))
        .toBe('Run `npm run **test**` to test');
    });
  });

  describe('mixed formatting', () => {
    it('should handle bold + links together', () => {
      expect(markdownToMrkdwn('**Check** [this](https://example.com)'))
        .toBe('*Check* <https://example.com|this>');
    });

    it('should handle plain text unchanged', () => {
      expect(markdownToMrkdwn('Just plain text')).toBe('Just plain text');
    });

    it('should handle empty string', () => {
      expect(markdownToMrkdwn('')).toBe('');
    });
  });
});

// ---------------------------------------------------------------------------
// splitMessage
// ---------------------------------------------------------------------------

describe('splitMessage', () => {
  it('should return single chunk for short messages', () => {
    expect(splitMessage('Hello')).toEqual(['Hello']);
  });

  it('should return single chunk at exactly the limit', () => {
    const text = 'a'.repeat(3000);
    expect(splitMessage(text)).toEqual([text]);
  });

  it('should split at newline boundaries', () => {
    // Each line is 1500 chars. Two lines + newline = 3001, which exceeds the 3000 limit.
    // So each line gets its own chunk.
    const line = 'a'.repeat(1500);
    const text = `${line}\n${line}\n${line}`;
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(3);
    expect(chunks[0]).toBe(line);
    expect(chunks[1]).toBe(line);
    expect(chunks[2]).toBe(line);
  });

  it('should hard-cut when no newlines exist', () => {
    const text = 'a'.repeat(6000);
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(3000);
    expect(chunks[1]!.length).toBe(3000);
  });

  it('should respect custom limit', () => {
    const text = 'a'.repeat(100);
    const chunks = splitMessage(text, 30);
    expect(chunks.length).toBe(4); // 30 + 30 + 30 + 10
    expect(chunks[0]!.length).toBe(30);
    expect(chunks[3]!.length).toBe(10);
  });

  it('should handle empty string', () => {
    expect(splitMessage('')).toEqual(['']);
  });

  it('should strip leading newline from continuation chunks', () => {
    const text = 'Hello\nWorld\nFoo\nBar';
    // With a very small limit that forces split at 'Hello\nWorld'
    const chunks = splitMessage(text, 12);
    // 'Hello\nWorld' is 11 chars, then split at the \n before 'Foo'
    for (const chunk of chunks) {
      expect(chunk.startsWith('\n')).toBe(false);
    }
  });

  it('should handle multiple chunks for very long messages', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}: ${'x'.repeat(200)}`);
    const text = lines.join('\n');
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    // All chunks should be within limit
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(3000);
    }
    // Reassembled text should have same total content
    const reassembled = chunks.join('\n');
    // Account for stripped newlines at split points
    expect(reassembled.length).toBeLessThanOrEqual(text.length);
  });

  it('should use 3000 as default limit (Slack Block Kit limit)', () => {
    const text = 'a'.repeat(3001);
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(3000);
  });
});
