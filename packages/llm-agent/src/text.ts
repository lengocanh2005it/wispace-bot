/**
 * Strip common Markdown markers so plain-text chat surfaces don't show literal * or **.
 */
export function sanitizeReplyText(text: string): string {
  return text
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
