/**
 * Encodes a Buffer to base64url (URL-safe base64 without padding).
 * Used for PKCE code_verifier / code_challenge generation.
 */
export function base64url(input: Buffer): string {
  return input
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}
