import { readResponseText } from './read-response-text';

/**
 * Read a response body with a size cap and parse it as JSON.
 *
 * Defence-in-depth against malformed or unexpectedly large upstream responses.
 * Reuses the existing bounded `readResponseText` reader pattern.
 *
 * @throws {ResponseSizeError} when the body exceeds `maxBytes`
 * @throws {SyntaxError} when the body is not valid JSON
 */
export async function readBoundedJson<T = unknown>(
  response: Response,
  maxBytes?: number,
): Promise<T> {
  const text = await readResponseText(response, maxBytes);
  return JSON.parse(text) as T;
}
