import type { LlmUsageRepository } from './llm-usage.repository';
import type { RecordLlmUsageInput, UsageWriterPort } from './types';

/**
 * Fire-and-forget insert straight to Postgres with 1 retry on transient
 * errors. Logs warning on final failure — no dead letter queue (usage
 * data is best-effort, not critical path).
 */
export class DirectUsageWriter implements UsageWriterPort {
  private static readonly MAX_RETRIES = 1;
  private static readonly RETRY_DELAY_MS = 500;

  private disposed = false;

  constructor(
    private readonly repository: LlmUsageRepository,
    private readonly onError?: (error: unknown) => void,
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

      setTimeout(() => {
        if (!this.disposed) {
          this.writeWithRetry(event, attempt + 1);
        }
      }, DirectUsageWriter.RETRY_DELAY_MS);
    });
  }
}
