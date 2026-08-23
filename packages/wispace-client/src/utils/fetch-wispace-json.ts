import { readResponseText } from '@wispace/bot-common';

const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024;
const ARRAY_MAX_RESPONSE_BYTES = 64 * 1024;

export interface FetchWispaceJsonOptions {
  /** Max response body bytes. Default: 16KB (objects), pass ARRAY_MAX_RESPONSE_BYTES for arrays. */
  maxBytes?: number;
}

/**
 * Read a WISPACE response with a byte limit, then parse as JSON.
 *
 * Prevents unbounded memory allocation from oversized upstream responses.
 * Delegates byte limiting to `readResponseText` from `bot-common`.
 *
 * @returns Parsed JSON as `unknown` — caller validates the shape.
 * @throws On oversized body (> maxBytes) or malformed JSON.
 */
export async function fetchWispaceJson(
  response: Response,
  options?: FetchWispaceJsonOptions,
): Promise<unknown> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const text = await readResponseText(response, maxBytes);

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      `WISPACE response is not valid JSON (read ${text.length} chars)`,
    );
  }
}

/** 64KB — use for array-returning endpoints (TaskScoreAverage, UserCalendar list). */
export const ARRAY_MAX_BYTES = ARRAY_MAX_RESPONSE_BYTES;
