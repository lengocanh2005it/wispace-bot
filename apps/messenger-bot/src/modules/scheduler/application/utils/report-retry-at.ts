import { jitteredDelayMs } from '@wispace/bot-common/utils';

/**
 * `next_retry_at` for a failed report-send job: the flat `retryBackoffMinutes`
 * window with the shared equal-jitter (50–100% of nominal) applied, so a batch
 * of jobs that failed on the same WISPACE outage do not all come due on the
 * same poll tick. `rng`/`now` are injectable for deterministic tests.
 */
export function reportRetryAt(
  retryBackoffMinutes: number,
  rng?: () => number,
  now: number = Date.now(),
): Date {
  return new Date(now + jitteredDelayMs(retryBackoffMinutes * 60_000, rng));
}
