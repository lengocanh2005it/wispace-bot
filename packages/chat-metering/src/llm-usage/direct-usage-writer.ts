import { jitteredDelayMs } from '@wispace/bot-common/utils';
import type { LlmUsageRepository } from './llm-usage.repository';
import type { RecordLlmUsageInput, UsageWriterPort } from './types';

/**
 * Fire-and-forget insert straight to Postgres with 1 retry on any error.
 * Reports final failure through `onError` — no dead letter queue (usage
 * data is best-effort, not critical path).
 *
 * The retry delay is equal-jittered (#1490, docs/project-overview.md §7.1.1):
 * a fleet-wide Postgres write failure fails every in-flight turn at once, so a
 * flat delay would re-align them. `RETRY_DELAY_MS` is the nominal ceiling —
 * nothing to cap before the helper.
 */
export class DirectUsageWriter implements UsageWriterPort {
  private static readonly MAX_RETRIES = 1;
  private static readonly RETRY_DELAY_MS = 500;

  private disposed = false;

  constructor(
    private readonly repository: LlmUsageRepository,
    private readonly onError?: (error: unknown) => void,
    private readonly rng?: () => number,
  ) {}

  /** Cancel pending retries — call during graceful shutdown. */
  dispose(): void {
    this.disposed = true;
  }

  write(event: RecordLlmUsageInput & { usageDate: string }): void {
    this.writeWithRetry(event, 0);
  }

  private writeWithRetry(
    event: RecordLlmUsageInput & { usageDate: string },
    attempt: number,
  ): void {
    this.repository.insertUsage(event).catch((error: unknown) => {
      const isLastAttempt = attempt >= DirectUsageWriter.MAX_RETRIES;
      if (isLastAttempt) {
        this.onError?.(error);
        return;
      }

      setTimeout(
        () => {
          if (!this.disposed) {
            this.writeWithRetry(event, attempt + 1);
          }
        },
        jitteredDelayMs(DirectUsageWriter.RETRY_DELAY_MS, this.rng),
      );
    });
  }
}
