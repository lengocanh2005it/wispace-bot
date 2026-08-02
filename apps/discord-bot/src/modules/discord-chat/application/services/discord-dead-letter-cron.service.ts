import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { DiscordDeadLetterService } from './discord-dead-letter.service';
import { DiscordOutboundService } from './discord-outbound.service';

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_MIN_RETRY_AGE_MS = 60_000;
const DEFAULT_RETRY_LIMIT = 10;

/**
 * Retries failed Discord message deliveries from the dead letter queue.
 * Runs every 5 minutes. Single-pod safe (Discord uses WebSocket, not webhooks).
 */
@Injectable()
export class DiscordDeadLetterCronService {
  private readonly logger = new Logger(DiscordDeadLetterCronService.name);

  constructor(
    private readonly deadLetterService: DiscordDeadLetterService,
    private readonly outboundService: DiscordOutboundService,
    private readonly configService: ConfigService,
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

    const olderThan = new Date(Date.now() - minRetryAgeMs);
    const entries = await this.deadLetterService.listPendingForRetry({
      limit: retryLimit,
      olderThan,
      maxRetries,
    });

    if (entries.length === 0) return;

    this.logger.log(`Retrying ${entries.length} dead letter entries`);

    for (const entry of entries) {
      try {
        const payload = entry.rawPayload as {
          discordUserId?: string;
          text?: string;
        };
        if (!payload.discordUserId || !payload.text) {
          await this.deadLetterService.markAbandoned(
            entry.id,
            'Missing discordUserId or text in payload',
          );
          continue;
        }

        await this.outboundService.sendText(
          payload.discordUserId,
          payload.text,
          { skipDeadLetter: true },
        );
        await this.deadLetterService.markReplayed(entry.id);
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);

        if ((entry.retryCount ?? 0) + 1 >= maxRetries) {
          await this.deadLetterService.markAbandoned(entry.id, errorMsg);
        } else {
          await this.deadLetterService.incrementRetry(entry.id, errorMsg);
        }
      }
    }
  }
}
