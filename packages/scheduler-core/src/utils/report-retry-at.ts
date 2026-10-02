import { jitteredDelayMs } from '@wispace/bot-common/utils';

/**
 * `next_retry_at` for a failed report-send job: the nominal backoff window
 * with shared equal-jitter applied, so a batch of jobs that failed on one
 * upstream outage does not all become due on the same poll tick. `rng` and
 * `now` are injectable for deterministic tests.
 */
export function reportRetryAt(
  retryBackoffMinutes: number,
  rng?: () => number,
  now: number = Date.now(),
): Date {
  return new Date(now + jitteredDelayMs(retryBackoffMinutes * 60_000, rng));
}
