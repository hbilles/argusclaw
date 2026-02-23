/**
 * Pure formatting and utility functions for the Slack bridge.
 *
 * Extracted from index.ts so they can be unit-tested independently.
 */

// ---------------------------------------------------------------------------
// Chat ID helpers
// ---------------------------------------------------------------------------

/** Prefix Slack channel IDs to distinguish from Telegram (numeric) and web (UUID). */
export function slackChatId(channelId: string): string {
  return `slack:${channelId}`;
}

/** Extract raw Slack channel ID from a prefixed chatId. Returns null if not a Slack chatId. */
export function extractSlackChannel(chatId: string): string | null {
  return chatId.startsWith('slack:') ? chatId.slice(6) : null;
}

// ---------------------------------------------------------------------------
// Tool formatting
// ---------------------------------------------------------------------------

/** Format a tool call for display in the approval message. */
export function formatToolSummary(toolName: string, toolInput: Record<string, unknown>): string {
  switch (toolName) {
    case 'write_file':
      return `write_file \u2192 ${String(toolInput['path'] ?? 'unknown')}`;
    case 'read_file':
      return `read_file \u2192 ${String(toolInput['path'] ?? 'unknown')}`;
    case 'list_directory':
      return `list_directory \u2192 ${String(toolInput['path'] ?? 'unknown')}`;
    case 'search_files':
      return `search_files \u2192 ${String(toolInput['path'] ?? '.')}`;
    case 'run_shell_command': {
      const cmd = String(toolInput['command'] ?? '');
      const display = cmd.length > 60 ? cmd.slice(0, 60) + '...' : cmd;
      return `run_shell_command \u2192 \`${display}\``;
    }
    case 'browse_web': {
      const url = String(toolInput['url'] ?? 'unknown URL');
      const action = String(toolInput['action'] ?? 'navigate');
      return `browse_web \u2192 ${url} (${action})`;
    }
    default:
      return toolName;
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
 * Convert standard Markdown to Slack mrkdwn format.
 *
 * Handles:
 * - **bold** or __bold__ → *bold*
 * - *italic* or _italic_ → _italic_ (already correct for Slack)
 * - `code` → `code` (same)
 * - ```code blocks``` → ```code blocks``` (same)
 * - [text](url) → <url|text>
 * - # Headers → *Headers* (bold)
 */
export function markdownToMrkdwn(text: string): string {
  // Protect code blocks
  const codeBlocks: string[] = [];
  let processed = text.replace(/```(?:\w*\n)?([\s\S]*?)```/g, (_match, code: string) => {
    const index = codeBlocks.length;
    codeBlocks.push(code);
    return `\x00CODEBLOCK${index}\x00`;
  });

  // Protect inline code
  const inlineCodes: string[] = [];
  processed = processed.replace(/`([^`]+)`/g, (_match, code: string) => {
    const index = inlineCodes.length;
    inlineCodes.push(code);
    return `\x00INLINE${index}\x00`;
  });

  // Convert bold: **text** or __text__ → placeholder (protect from italic pass)
  const bolds: string[] = [];
  processed = processed.replace(/\*\*(.+?)\*\*/g, (_match, inner: string) => {
    const index = bolds.length;
    bolds.push(inner);
    return `\x00BOLD${index}\x00`;
  });
  processed = processed.replace(/__(.+?)__/g, (_match, inner: string) => {
    const index = bolds.length;
    bolds.push(inner);
    return `\x00BOLD${index}\x00`;
  });

  // Italic: *text* → _text_ (Slack uses _ for italic)
  processed = processed.replace(/(?<!\*)\*(?!\*)([^*]+?)(?<!\*)\*(?!\*)/g, '_$1_');

  // Links: [text](url) → <url|text>
  processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');

  // Headers: # text → *text* (bold in Slack)
  processed = processed.replace(/^#{1,6}\s+(.+)$/gm, '*$1*');

  // Restore bold placeholders → *text* (Slack bold)
  processed = processed.replace(/\x00BOLD(\d+)\x00/g, (_match, index: string) => {
    return '*' + bolds[parseInt(index)]! + '*';
  });

  // Restore code blocks
  processed = processed.replace(/\x00CODEBLOCK(\d+)\x00/g, (_match, index: string) => {
    return '```' + codeBlocks[parseInt(index)]! + '```';
  });

  // Restore inline code
  processed = processed.replace(/\x00INLINE(\d+)\x00/g, (_match, index: string) => {
    return '`' + inlineCodes[parseInt(index)]! + '`';
  });

  return processed;
}

/**
 * Split a message into chunks that fit within Slack's character limit.
 * Tries to break at newline boundaries for cleaner splits.
 */
export function splitMessage(text: string, limit = 3000): string[] {
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
