/**
 * Equal-jitter for retry delays: returns a value uniformly in
 * `[nominalMs / 2, nominalMs)`. Keeps a 50% floor so backoff still grows
 * roughly monotonically while spreading many aligned retries so they do not
 * fire in the same instant after a shared upstream failure (thundering herd).
 *
 * This is the one jitter formula for every retry path (shared LLM retry,
 * durable webhook/report/reminder `next_retry_at`). `rng` is injectable so
 * tests are deterministic; production passes the default `Math.random`.
 */
export function jitteredDelayMs(
  nominalMs: number,
  rng: () => number = Math.random,
): number {
  return nominalMs * (0.5 + rng() * 0.5);
}
