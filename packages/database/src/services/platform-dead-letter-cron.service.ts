import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { subtractMs } from '@wispace/date-utils';
import { errorMessage } from '@wispace/bot-common';
import { PlatformDeadLetterService } from './platform-dead-letter.service';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MIN_RETRY_AGE_MS = 60_000;
const DEFAULT_RETRY_LIMIT = 10;

export interface DeadLetterCronOptions {
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
 * Retries failed platform message deliveries from the dead letter queue.
 * Runs every 5 minutes. Single-pod safe (Discord uses WebSocket, Zalo uses
 * pull-based delivery — neither depends on webhook reachability).
 */
@Injectable()
export class PlatformDeadLetterCronService {
  private readonly logger = new Logger(PlatformDeadLetterCronService.name);

  constructor(
    private readonly deadLetterService: PlatformDeadLetterService,
    private readonly configService: ConfigService,
    private readonly options: DeadLetterCronOptions,
  ) {}

  @Cron('0 */5 * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleRetry(): Promise<void> {
    const maxRetries =
      this.configService.get<number>('WEBHOOK_DEAD_LETTER_MAX_RETRIES') ??
      DEFAULT_MAX_RETRIES;
    const minRetryAgeMs =
      this.configService.get<number>('WEBHOOK_DEAD_LETTER_MIN_RETRY_AGE_MS') ??
      DEFAULT_MIN_RETRY_AGE_MS;
    const retryLimit =
      this.configService.get<number>('WEBHOOK_DEAD_LETTER_RETRY_LIMIT') ??
      DEFAULT_RETRY_LIMIT;

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
}
