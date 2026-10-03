/**
 * The send exceeded its own deadline while the caller was still waiting.
 *
 * The SDK reports every abort identically — `@discordjs/rest` aborts through a
 * private controller with no reason — so the transport adapter attributes the
 * cause before the error reaches the application layer (ADR-0053) and the
 * delivery-classification predicate keys off this type rather than off
 * `isAbortError`.
 *
 * Ambiguous but **not** retryable: the provider may have accepted the message,
 * so a resend risks a duplicate. Zalo draws the same line at
 * `httpStatus === 0`.
 */
export class DiscordSendTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`Discord send exceeded its ${timeoutMs}ms deadline`);
    this.name = 'DiscordSendTimeoutError';
  }
}
