/**
 * Unit tests for Telegram bridge formatting and utility functions.
 *
 * Tests cover:
 * - MarkdownV2 escaping (escapeMarkdown)
 * - HTML escaping (escapeHtml)
 * - Tool display formatting (formatToolSummary)
 * - LLM response cleaning (cleanLLMResponse)
 * - Message chunking (splitMessage)
 * - Markdown → Telegram HTML conversion (markdownToTelegramHtml)
 */

import { describe, it, expect } from 'vitest';
import {
  escapeMarkdown,
  escapeHtml,
  formatToolSummary,
  cleanLLMResponse,
  splitMessage,
  markdownToTelegramHtml,
} from '../src/formatting.js';

// ---------------------------------------------------------------------------
// escapeMarkdown (MarkdownV2)
// ---------------------------------------------------------------------------

describe('escapeMarkdown', () => {
  it('should escape underscores', () => {
    expect(escapeMarkdown('hello_world')).toBe('hello\\_world');
  });

  it('should escape asterisks', () => {
    expect(escapeMarkdown('**bold**')).toBe('\\*\\*bold\\*\\*');
  });

  it('should escape square brackets', () => {
    expect(escapeMarkdown('[link]')).toBe('\\[link\\]');
  });

  it('should escape parentheses', () => {
    expect(escapeMarkdown('(parens)')).toBe('\\(parens\\)');
  });

  it('should escape backticks', () => {
    expect(escapeMarkdown('`code`')).toBe('\\`code\\`');
  });

  it('should escape dots and exclamation marks', () => {
    expect(escapeMarkdown('Hello! End.')).toBe('Hello\\! End\\.');
  });

  it('should escape hash/pound', () => {
    expect(escapeMarkdown('# heading')).toBe('\\# heading');
  });

  it('should escape hyphens and plus', () => {
    expect(escapeMarkdown('a-b+c')).toBe('a\\-b\\+c');
  });

  it('should escape tilde and pipe', () => {
    expect(escapeMarkdown('~strikethrough~ | pipe')).toBe('\\~strikethrough\\~ \\| pipe');
  });

  it('should escape curly braces and equals', () => {
    expect(escapeMarkdown('{a=b}')).toBe('\\{a\\=b\\}');
  });

  it('should escape greater-than', () => {
    expect(escapeMarkdown('> quote')).toBe('\\> quote');
  });

  it('should not escape regular alphanumeric text', () => {
    expect(escapeMarkdown('Hello World 123')).toBe('Hello World 123');
  });

  it('should handle empty string', () => {
    expect(escapeMarkdown('')).toBe('');
  });

  it('should handle path-like strings', () => {
    expect(escapeMarkdown('/workspace/test.ts')).toBe('/workspace/test\\.ts');
  });
});

// ---------------------------------------------------------------------------
// escapeHtml
// ---------------------------------------------------------------------------

describe('escapeHtml', () => {
  it('should escape ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('should escape less-than', () => {
    expect(escapeHtml('a < b')).toBe('a &lt; b');
  });

  it('should escape greater-than', () => {
    expect(escapeHtml('a > b')).toBe('a &gt; b');
  });

  it('should escape all three in combination', () => {
    expect(escapeHtml('<div class="test">&</div>'))
      .toBe('&lt;div class="test"&gt;&amp;&lt;/div&gt;');
  });

  it('should not escape other characters', () => {
    expect(escapeHtml('Hello "World" 123')).toBe('Hello "World" 123');
  });

  it('should handle empty string', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('should handle double-escaping prevention', () => {
    // If input already has &amp;, it should be re-escaped
    expect(escapeHtml('&amp;')).toBe('&amp;amp;');
  });
});

// ---------------------------------------------------------------------------
// formatToolSummary
// ---------------------------------------------------------------------------

describe('formatToolSummary', () => {
  it('should format write_file with escaped path', () => {
    const result = formatToolSummary('write_file', { path: '/workspace/test.ts', content: 'code' });
    expect(result).toContain('write\\_file');
    expect(result).toContain('/workspace/test\\.ts');
  });

  it('should format read_file with escaped path', () => {
    const result = formatToolSummary('read_file', { path: '/workspace/config.json' });
    expect(result).toContain('read\\_file');
    expect(result).toContain('/workspace/config\\.json');
  });

  it('should format list_directory with escaped path', () => {
    const result = formatToolSummary('list_directory', { path: '/workspace' });
    expect(result).toContain('list\\_directory');
  });

  it('should format search_files with default path', () => {
    const result = formatToolSummary('search_files', { pattern: 'TODO' });
    expect(result).toContain('search\\_files');
    expect(result).toContain('\\.');
  });

  it('should format run_shell_command with short command', () => {
    const result = formatToolSummary('run_shell_command', { command: 'ls -la' });
    expect(result).toContain('run\\_shell\\_command');
    expect(result).toContain('ls \\-la');
  });

  it('should truncate long shell commands with ellipsis', () => {
    const longCmd = 'find / -name "*.ts" -exec grep -l "import" {} \\; | sort -u | head -20';
    const result = formatToolSummary('run_shell_command', { command: longCmd });
    expect(result).toContain('\u2026'); // Unicode ellipsis
  });

  it('should format browse_web with URL and action', () => {
    const result = formatToolSummary('browse_web', { url: 'https://example.com', action: 'extract' });
    expect(result).toContain('browse\\_web');
    expect(result).toContain('https://example\\.com');
    expect(result).toContain('\\(extract\\)');
  });

  it('should use default navigate action for browse_web', () => {
    const result = formatToolSummary('browse_web', { url: 'https://example.com' });
    expect(result).toContain('\\(navigate\\)');
  });

  it('should handle missing path with fallback', () => {
    const result = formatToolSummary('write_file', { content: 'test' });
    expect(result).toContain('unknown');
  });

  it('should escape unknown tool names', () => {
    const result = formatToolSummary('my_custom.tool', { foo: 'bar' });
    expect(result).toContain('my\\_custom\\.tool');
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

  it('should handle nested angle brackets inside think', () => {
    expect(cleanLLMResponse('<think>if (x < 5) { y > 3 }</think>Result'))
      .toBe('Result');
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
    const text = 'a'.repeat(4096);
    expect(splitMessage(text)).toEqual([text]);
  });

  it('should split at newline boundaries', () => {
    const line = 'a'.repeat(2000);
    const text = `${line}\n${line}\n${line}`;
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]).toBe(`${line}\n${line}`);
    expect(chunks[1]).toBe(line);
  });

  it('should hard-cut when no newlines exist', () => {
    const text = 'a'.repeat(8192);
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(4096);
    expect(chunks[1]!.length).toBe(4096);
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
    const chunks = splitMessage(text, 12);
    for (const chunk of chunks) {
      expect(chunk.startsWith('\n')).toBe(false);
    }
  });

  it('should use 4096 as default limit (Telegram limit)', () => {
    const text = 'a'.repeat(4097);
    const chunks = splitMessage(text);
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.length).toBe(4096);
  });

  it('should handle multiple chunks for very long messages', () => {
    const lines = Array.from({ length: 20 }, (_, i) => `Line ${i}: ${'x'.repeat(300)}`);
    const text = lines.join('\n');
    const chunks = splitMessage(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096);
    }
  });
});

// ---------------------------------------------------------------------------
// markdownToTelegramHtml
// ---------------------------------------------------------------------------

describe('markdownToTelegramHtml', () => {
  describe('bold conversion', () => {
    it('should convert **bold** to <b>bold</b>', () => {
      expect(markdownToTelegramHtml('This is **bold** text'))
        .toBe('This is <b>bold</b> text');
    });

    it('should convert __bold__ to <b>bold</b>', () => {
      expect(markdownToTelegramHtml('This is __bold__ text'))
        .toBe('This is <b>bold</b> text');
    });

    it('should handle multiple bold phrases', () => {
      expect(markdownToTelegramHtml('**one** and **two**'))
        .toBe('<b>one</b> and <b>two</b>');
    });
  });

  describe('italic conversion', () => {
    it('should convert *italic* to <i>italic</i>', () => {
      expect(markdownToTelegramHtml('This is *italic* text'))
        .toBe('This is <i>italic</i> text');
    });

    it('should convert _italic_ to <i>italic</i>', () => {
      expect(markdownToTelegramHtml('This is _italic_ text'))
        .toBe('This is <i>italic</i> text');
    });
  });

  describe('link conversion', () => {
    it('should convert [text](url) to <a href="url">text</a>', () => {
      expect(markdownToTelegramHtml('[Click here](https://example.com)'))
        .toBe('<a href="https://example.com">Click here</a>');
    });

    it('should handle multiple links', () => {
      const result = markdownToTelegramHtml('[A](https://a.com) and [B](https://b.com)');
      expect(result).toContain('<a href="https://a.com">A</a>');
      expect(result).toContain('<a href="https://b.com">B</a>');
    });
  });

  describe('code protection', () => {
    it('should wrap inline code in <code> tags', () => {
      expect(markdownToTelegramHtml('Use `npm install` here'))
        .toBe('Use <code>npm install</code> here');
    });

    it('should wrap code blocks in <pre> tags', () => {
      const input = 'Before\n```\nconst x = 1;\n```\nAfter';
      const result = markdownToTelegramHtml(input);
      expect(result).toContain('<pre>const x = 1;\n</pre>');
    });

    it('should not convert formatting inside inline code', () => {
      expect(markdownToTelegramHtml('Run `**not bold**` here'))
        .toBe('Run <code>**not bold**</code> here');
    });

    it('should not convert formatting inside code blocks', () => {
      const input = '```\n**not bold**\n```';
      const result = markdownToTelegramHtml(input);
      expect(result).not.toContain('<b>');
      expect(result).toContain('**not bold**');
    });

    it('should HTML-escape content inside code blocks', () => {
      const input = '```\nif (a < b && c > d) {}\n```';
      const result = markdownToTelegramHtml(input);
      expect(result).toContain('&lt;');
      expect(result).toContain('&amp;');
      expect(result).toContain('&gt;');
    });

    it('should HTML-escape content inside inline code', () => {
      expect(markdownToTelegramHtml('Use `<div>`'))
        .toBe('Use <code>&lt;div&gt;</code>');
    });

    it('should strip language specifier from code blocks', () => {
      const input = '```typescript\nconst x = 1;\n```';
      const result = markdownToTelegramHtml(input);
      expect(result).toContain('<pre>const x = 1;\n</pre>');
      expect(result).not.toContain('typescript');
    });
  });

  describe('HTML escaping', () => {
    it('should HTML-escape regular text', () => {
      expect(markdownToTelegramHtml('a < b & c > d'))
        .toBe('a &lt; b &amp; c &gt; d');
    });

    it('should not double-escape HTML inside code', () => {
      const input = 'Text with `&amp;` code';
      const result = markdownToTelegramHtml(input);
      // The &amp; inside code should be escaped to &amp;amp;
      expect(result).toContain('<code>&amp;amp;</code>');
    });
  });

  describe('mixed formatting', () => {
    it('should handle bold + italic + link', () => {
      const result = markdownToTelegramHtml('**Bold** and *italic* with [link](https://x.com)');
      expect(result).toContain('<b>Bold</b>');
      expect(result).toContain('<i>italic</i>');
      expect(result).toContain('<a href="https://x.com">link</a>');
    });

    it('should handle plain text unchanged (except HTML escaping)', () => {
      expect(markdownToTelegramHtml('Just plain text')).toBe('Just plain text');
    });

    it('should handle empty string', () => {
      expect(markdownToTelegramHtml('')).toBe('');
    });
  });
});
