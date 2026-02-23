/**
 * Pure formatting and utility functions for the Telegram bridge.
 *
 * Extracted from index.ts so they can be unit-tested independently.
 */

// ---------------------------------------------------------------------------
// Telegram MarkdownV2 Escaping
// ---------------------------------------------------------------------------

/** Escape special Markdown characters for Telegram MarkdownV2. */
export function escapeMarkdown(text: string): string {
  return text.replace(/([_*[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

/** Escape HTML special characters. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ---------------------------------------------------------------------------
// Tool formatting
// ---------------------------------------------------------------------------

/** Format a tool call for display in the approval message. */
export function formatToolSummary(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'write_file':
      return `write\\_file → ${escapeMarkdown(String(toolInput['path'] ?? 'unknown'))}`;
    case 'read_file':
      return `read\\_file → ${escapeMarkdown(String(toolInput['path'] ?? 'unknown'))}`;
    case 'list_directory':
      return `list\\_directory → ${escapeMarkdown(String(toolInput['path'] ?? 'unknown'))}`;
    case 'search_files':
      return `search\\_files → ${escapeMarkdown(String(toolInput['path'] ?? '.'))}`;
    case 'run_shell_command': {
      const cmd = String(toolInput['command'] ?? '');
      const display = cmd.length > 60 ? cmd.slice(0, 60) + '\u2026' : cmd;
      return `run\\_shell\\_command → \`${escapeMarkdown(display)}\``;
    }
    case 'browse_web': {
      const url = String(toolInput['url'] ?? 'unknown URL');
      const action = String(toolInput['action'] ?? 'navigate');
      return `browse\\_web → ${escapeMarkdown(url)} \\(${escapeMarkdown(action)}\\)`;
    }
    default:
      return `${escapeMarkdown(toolName)}`;
  }
}

// ---------------------------------------------------------------------------
// LLM Response Formatting
// ---------------------------------------------------------------------------

/**
 * Strip <think>...</think> blocks from LLM responses.
 * Thinking models (e.g., Qwen) emit chain-of-thought reasoning in these tags
 * that should not be shown to the user.
 */
export function cleanLLMResponse(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/g, '').trim();
}

/**
 * Split a message into chunks that fit within Telegram's character limit.
 * Tries to break at newline boundaries for cleaner splits.
 */
export function splitMessage(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    if (remaining.length <= limit) {
      chunks.push(remaining);
      break;
    }

    // Try to split at the last newline before the limit
    let splitAt = remaining.lastIndexOf('\n', limit);
    if (splitAt <= 0) splitAt = limit; // No good split point — hard cut

    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).replace(/^\n/, '');
  }

  return chunks;
}

/**
 * Convert standard Markdown to Telegram HTML.
 *
 * Handles: **bold**, *italic*, _italic_, `code`, ```code blocks```,
 * and [links](url). Falls back gracefully — unrecognized Markdown
 * is left as-is (just HTML-escaped).
 *
 * Uses Telegram HTML parse_mode which is far more forgiving than MarkdownV2.
 */
export function markdownToTelegramHtml(text: string): string {
  // First, extract and protect code blocks (```...```) so they aren't processed
  const codeBlocks: string[] = [];
  let processed = text.replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_match, code: string) => {
    const index = codeBlocks.length;
    codeBlocks.push(code);
    return `\x00CODEBLOCK${index}\x00`;
  });

  // Extract and protect inline code (`...`)
  const inlineCodes: string[] = [];
  processed = processed.replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = inlineCodes.length;
    inlineCodes.push(code);
    return `\x00INLINE${index}\x00`;
  });

  // HTML-escape the rest of the text
  processed = escapeHtml(processed);

  // Convert Markdown formatting to HTML
  // Bold: **text** or __text__
  processed = processed.replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');
  processed = processed.replace(/__(.+?)__/g, '<b>$1</b>');

  // Italic: *text* or _text_ (but not inside words with underscores)
  processed = processed.replace(/(?<!\w)\*([^*]+?)\*(?!\w)/g, '<i>$1</i>');
  processed = processed.replace(/(?<!\w)_([^_]+?)_(?!\w)/g, '<i>$1</i>');

  // Links: [text](url)
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');

  // Restore code blocks
  processed = processed.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, index: string) => {
    return `<pre>${escapeHtml(codeBlocks[parseInt(index)]!)}</pre>`;
  });

  // Restore inline code
  processed = processed.replace(/\x00INLINE(\d+)\x00/g, (_match, index: string) => {
    return `<code>${escapeHtml(inlineCodes[parseInt(index)]!)}</code>`;
  });

  return processed;
}
