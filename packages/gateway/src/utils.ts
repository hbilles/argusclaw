/**
 * Shared utilities used by both the gateway index and the web dashboard.
 */

import type * as http from 'node:http';

// ---------------------------------------------------------------------------
// Complex request detection
// ---------------------------------------------------------------------------

const COMPLEX_KEYWORDS = [
  'set up', 'setup', 'create a project', 'scaffold', 'initialize',
  'configure', 'build me', 'build a', 'set up a', 'install and configure',
  'step by step', 'steps', 'multi-step', 'pipeline', 'workflow',
  'deploy', 'migration', 'refactor', 'restructure', 'convert',
];

export function isComplexRequest(content: string): boolean {
  const lower = content.toLowerCase();
  const matchCount = COMPLEX_KEYWORDS.filter((kw) => lower.includes(kw)).length;
  const conjunctions = (lower.match(/\band\b|\bthen\b|\balso\b|\bwith\b/g) || []).length;
  return matchCount >= 1 || conjunctions >= 3;
}

// ---------------------------------------------------------------------------
// HTTP body parsing
// ---------------------------------------------------------------------------

export function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Content extraction
// ---------------------------------------------------------------------------

/**
 * Extract plain text from LLM content blocks.
 * Content may be a string or an array of content blocks (Anthropic format).
 */
export function extractTextFromContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .filter((b: Record<string, unknown>) => b.type === 'text')
      .map((b: Record<string, unknown>) => b.text as string)
      .join('');
  }
  return '';
}
