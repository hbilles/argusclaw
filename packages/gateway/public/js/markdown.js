/**
 * Minimal markdown-to-HTML renderer.
 * Handles: code blocks, inline code, bold, italic, links, headers, lists, line breaks.
 */

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// Exported globally for Alpine.js access
window.simpleMarkdown = function simpleMarkdown(text) {
  if (!text) return '';

  // Escape HTML first
  text = escapeHtml(text);

  // Fenced code blocks (```lang\n...\n```)
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, function (_, lang, code) {
    return '<pre><code class="lang-' + lang + '">' + code.trim() + '</code></pre>';
  });

  // Inline code
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');

  // Headers (### h3, ## h2, # h1)
  text = text.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  text = text.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  text = text.replace(/^# (.+)$/gm, '<h1>$1</h1>');

  // Bold
  text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');

  // Italic
  text = text.replace(/(?<!\w)\*([^*]+)\*(?!\w)/g, '<em>$1</em>');

  // Links
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');

  // Unordered lists (simple, single-level)
  text = text.replace(/^[*-] (.+)$/gm, '<li>$1</li>');
  text = text.replace(/(<li>[\s\S]*?<\/li>)/g, function (match) {
    if (match.indexOf('<ul>') === -1) {
      return '<ul>' + match + '</ul>';
    }
    return match;
  });
  // Clean up adjacent </ul><ul> pairs
  text = text.replace(/<\/ul>\s*<ul>/g, '');

  // Ordered lists
  text = text.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');

  // Paragraphs: convert double newlines into paragraph breaks
  text = text.replace(/\n\n/g, '</p><p>');

  // Single newlines → <br> (except inside pre/code blocks)
  // Simple approach: just replace remaining newlines
  text = text.replace(/\n/g, '<br>');

  // Wrap in paragraph
  text = '<p>' + text + '</p>';

  // Clean up empty paragraphs
  text = text.replace(/<p>\s*<\/p>/g, '');

  // Fix paragraphs wrapping block elements
  text = text.replace(/<p>(<pre>)/g, '$1');
  text = text.replace(/(<\/pre>)<\/p>/g, '$1');
  text = text.replace(/<p>(<h[123]>)/g, '$1');
  text = text.replace(/(<\/h[123]>)<\/p>/g, '$1');
  text = text.replace(/<p>(<ul>)/g, '$1');
  text = text.replace(/(<\/ul>)<\/p>/g, '$1');

  return text;
};
