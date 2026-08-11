import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { subtractMs } from '@wispace/date-utils';
import { errorMessage, PgAdvisoryLockService } from '@wispace/bot-common';
import { PlatformDeadLetterService } from './platform-dead-letter.service';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MIN_RETRY_AGE_MS = 60_000;
const DEFAULT_RETRY_LIMIT = 10;

export interface DeadLetterCronOptions {
  /** Advisory lock id — only one pod retries the dead letter per tick. */
  lockId: number;
  /** Extract the retry target (external user id + text) from a saved raw webhook payload. */
  extractPayload: (payload: Record<string, unknown>) => {
    externalUserId?: string;
    text?: string;
  };
  /** Mark-abandoned reason when the payload can't be extracted. */
  abandonReason: string;
  /** Platform outbound send (e.g. Discord passes `{ skipDeadLetter: true }`). */
  sendText: (externalUserId: string, text: string) => Promise<void>;
}

/**
 * Retries failed platform outbound deliveries from the dead letter queue.
 * Only `outbound` entries are replayed — inbound webhook events are never
 * re-sent via `sendText` (that used to echo the user's own text back).
 * Runs every 5 minutes under an advisory lock (multi-pod safe).
 */
@Injectable()
export class PlatformDeadLetterCronService {
  private readonly logger = new Logger(PlatformDeadLetterCronService.name);

  constructor(
    private readonly deadLetterService: PlatformDeadLetterService,
    private readonly configService: ConfigService,
    private readonly pgLock: PgAdvisoryLockService,
    private readonly options: DeadLetterCronOptions,
  ) {}

  @Cron('0 */5 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleRetry(): Promise<void> {
    const result = await this.pgLock.withLock(this.options.lockId, () =>
      this.runRetryBatch(),
    );

    if (result === null) {
      this.logger.debug(
        'webhook-dead-letter-retry skipped — lock held by another pod',
      );
    }
  }

  private async runRetryBatch(): Promise<void> {
    const maxRetries = this.readPositiveInt(
      'WEBHOOK_DEAD_LETTER_MAX_RETRIES',
      DEFAULT_MAX_RETRIES,
    );
    const minRetryAgeMs = this.readPositiveInt(
      'WEBHOOK_DEAD_LETTER_MIN_RETRY_AGE_MS',
      DEFAULT_MIN_RETRY_AGE_MS,
    );
    const retryLimit = this.readPositiveInt(
      'WEBHOOK_DEAD_LETTER_RETRY_LIMIT',
      DEFAULT_RETRY_LIMIT,
    );

    const olderThan = subtractMs(new Date(), minRetryAgeMs);
    const entries = await this.deadLetterService.listPendingForRetry({
      limit: retryLimit,
      olderThan,
      maxRetries,
    });

    if (entries.length === 0) return;

    this.logger.log(`Retrying ${entries.length} dead letter entries`);

    for (const entry of entries) {
      try {
        const payload = entry.rawPayload as Record<string, unknown>;
        const { externalUserId, text } = this.options.extractPayload(payload);
        if (!externalUserId || !text) {
          await this.deadLetterService.markAbandoned(
            entry.id,
            this.options.abandonReason,
          );
          continue;
        }

        await this.options.sendText(externalUserId, text);
        await this.deadLetterService.markReplayed(entry.id);
      } catch (error) {
        const errorMsg = errorMessage(error);

        if ((entry.retryCount ?? 0) + 1 >= maxRetries) {
          await this.deadLetterService.markAbandoned(entry.id, errorMsg);
        } else {
          await this.deadLetterService.incrementRetry(entry.id, errorMsg);
        }
      }
    }
  }

  private readPositiveInt(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }
}
