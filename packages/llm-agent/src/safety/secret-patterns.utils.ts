/**
 * Credential-shape matchers shared by BOTH sides of the model boundary
 * (#632): the input-side redaction (`redactSecrets`) and the output-side
 * final-output guard (#503). One list — a new shape is added once and both
 * directions inherit it.
 */

export const CREDENTIAL_SHAPES: Array<RegExp> = [
  // OpenAI-style keys.
  /\bsk-[A-Za-z0-9]{16,}\b/i,
  // Bearer tokens.
  /\bBearer\s+[A-Za-z0-9._~+/-]{20,}\b/i,
  // Explicit secret assignments (api_key/password/secret = value).
  /\b(?:api[_-]?key|password|passwd|secret)\s*[:=]\s*\S{8,}\b/i,
  // JWTs — three base64url segments; the signature segment is long enough
  // that ordinary prose never matches.
  /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{1,}\.[A-Za-z0-9_-]{10,}\b/,
  // Connection strings with embedded credentials (user may be empty:
  // redis://:password@host).
  /\b(?:postgres(?:ql)?|redis|mongodb(?:\+srv)?):\/\/[^\s/@]*:[^\s/@]+@[^\s]+/i,
];

/** First matching shape, or null — used by both scanners. */
export function findCredentialShape(text: string): RegExpMatchArray | null {
  for (const pattern of CREDENTIAL_SHAPES) {
    const match = text.match(pattern);
    if (match) {
      return match;
    }
  }
  return null;
}
