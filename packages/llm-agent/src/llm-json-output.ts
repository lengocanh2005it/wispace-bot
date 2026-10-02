export function parseJsonObject(content: string): Record<string, unknown> {
  const parsed = JSON.parse(content) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM JSON output must be an object');
  }

  return parsed as Record<string, unknown>;
}

export function readRequiredStringField(
  value: Record<string, unknown>,
  key: string,
  options?: { maxChars?: number; sanitize?: (raw: string) => string },
): string {
  const raw = value[key];
  if (typeof raw !== 'string') {
    throw new Error(`LLM JSON output missing string field: ${key}`);
  }

  const text = (options?.sanitize ?? ((input: string) => input))(raw)
    .replace(/\s+/g, ' ')
    .trim();
  if (!text) {
    throw new Error(`LLM JSON output has empty string field: ${key}`);
  }

  const maxChars = options?.maxChars ?? 600;
  return text.length > maxChars ? `${text.slice(0, maxChars).trim()}...` : text;
}
