import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { ADVISORY_LOCK } from '@messenger/shared/common/advisory-lock-ids';
import { PgAdvisoryLockService } from '@wispace/bot-common';
import { MESSENGER_WEBHOOK_DEAD_LETTER_REPOSITORY } from '../../domain/repositories/messenger-webhook-dead-letter.repository.port';
import type { MessengerWebhookDeadLetterRepositoryPort } from '../../domain/repositories/messenger-webhook-dead-letter.repository.port';
import { MessengerService } from './messenger.service';
import { readEnvPositiveInt } from '@messenger/shared/config/env-helpers';

@Injectable()
export class MessengerWebhookDeadLetterCronService {
  private readonly logger = new Logger(
    MessengerWebhookDeadLetterCronService.name,
  );

  constructor(
    private readonly messengerService: MessengerService,
    private readonly pgLock: PgAdvisoryLockService,
    private readonly configService: ConfigService,
    @Optional()
    @Inject(MESSENGER_WEBHOOK_DEAD_LETTER_REPOSITORY)
    private readonly deadLetterRepository?: MessengerWebhookDeadLetterRepositoryPort,
  ) {}

  /** Retry pending dead-letter entries every 5 minutes. Only one pod runs per tick. */
  @Cron('0 */5 * * * *', { name: 'webhook-dead-letter-retry' })
  async retryPendingDeadLetters(): Promise<void> {
    if (!this.deadLetterRepository) {
      return;
    }

    const result = await this.pgLock.withLock(
      ADVISORY_LOCK.MESSENGER_WEBHOOK_DEAD_LETTER_RETRY,
      () => this.runRetryBatch(),
    );

    if (result === null) {
      this.logger.debug(
        'webhook-dead-letter-retry skipped — lock held by another pod',
      );
    }
  }

  private async runRetryBatch(): Promise<void> {
    const maxRetries = readEnvPositiveInt(
      this.configService,
      'WEBHOOK_DEAD_LETTER_MAX_RETRIES',
      5,
    );
    const minAgeMs = readEnvPositiveInt(
      this.configService,
      'WEBHOOK_DEAD_LETTER_MIN_RETRY_AGE_MS',
      60_000,
    );
    const limit = readEnvPositiveInt(
      this.configService,
      'WEBHOOK_DEAD_LETTER_RETRY_LIMIT',
      20,
    );

    const olderThan = new Date(Date.now() - minAgeMs);

    const entries = await this.deadLetterRepository!.listPendingForRetry({
      limit,
      olderThan,
      maxRetries,
    });

    if (entries.length === 0) {
      return;
    }

    this.logger.log(`Dead-letter retry: processing ${entries.length} entry(s)`);

    let replayed = 0;
    let failed = 0;
    let abandoned = 0;

    for (const entry of entries) {
      const { handled, error } = await this.messengerService.replayWebhookEvent(
        entry.rawPayload,
      );

      if (handled || !error) {
        await this.deadLetterRepository!.markReplayed(entry.id);
        replayed += 1;
        this.logger.log(
          `Dead-letter id=${entry.id} psid=${entry.psid ?? 'n/a'} replayed successfully`,
        );
        continue;
      }

      const nextRetryCount = entry.retryCount + 1;

      if (nextRetryCount >= maxRetries) {
        await this.deadLetterRepository!.markAbandoned(
          entry.id,
          `Abandoned after ${nextRetryCount} retries. Last error: ${error}`,
        );
        abandoned += 1;
        this.logger.warn(
          `Dead-letter id=${entry.id} psid=${entry.psid ?? 'n/a'} abandoned after ${nextRetryCount} retries: ${error}`,
        );
      } else {
        await this.deadLetterRepository!.incrementRetry(entry.id, error);
        failed += 1;
        this.logger.warn(
          `Dead-letter id=${entry.id} psid=${entry.psid ?? 'n/a'} retry ${nextRetryCount}/${maxRetries} failed: ${error}`,
        );
      }
    }

    this.logger.log(
      `Dead-letter retry done: replayed=${replayed}, failed=${failed}, abandoned=${abandoned}`,
    );
  }
}
