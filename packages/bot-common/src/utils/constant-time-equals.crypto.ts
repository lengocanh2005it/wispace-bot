import { timingSafeEqual } from 'node:crypto';

/**
 * Compares two secrets without leaking their contents through timing.
 *
 * `timingSafeEqual` throws when the buffers differ in length, so the length is
 * compared first. The catch is deliberately redundant with that check: it is
 * what keeps a caller that bypasses the types (a plain string, a malformed
 * value) on the "reject" path instead of an exception, so an edit that removes
 * the length check degrades to a rejection rather than a crash.
 *
 * Callers own the encoding. Webhook signature checks pass the hex text as
 * utf8 bytes; the internal API key guard passes raw key bytes.
 */
export function constantTimeEquals(a: Buffer, b: Buffer): boolean {
  if (a.length !== b.length) {
    return false;
  }

  try {
    return timingSafeEqual(a, b);
  } catch {
    return false;
  }
}
