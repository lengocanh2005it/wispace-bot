/**
 * Parses an RFC 6265 `Cookie` header into a name-value map.
 * First occurrence of a duplicate name wins; malformed pairs are skipped.
 * Returns a null-prototype object so attacker-controlled names such as
 * `__proto__` cannot reach Object.prototype.
 */
export function parseCookieHeader(
  header: string | undefined | null,
): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = Object.create(null);
  for (const pair of header.split(';')) {
    const separatorIndex = pair.indexOf('=');
    if (separatorIndex <= 0) continue;
    const name = pair.slice(0, separatorIndex).trim();
    const rawValue = pair.slice(separatorIndex + 1).trim();
    if (!name || name in cookies) continue;
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}
