import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import {
  ADVISORY_LOCKS,
  errorMessage,
  maskExternalId,
  PgAdvisoryLockService,
} from '@wispace/bot-common';
import { DiscordAccountLinkService } from './discord-account-link.service';
import { DiscordRelinkNotifier } from './discord-relink-notifier.service';
import { retryWithBackoff } from '@discord/shared/utils/retry.utils';
import {
  DISCORD_LINK_VERIFY_RECORD_REPOSITORY,
  type DiscordLinkVerifyRecordRepositoryPort,
} from '../../domain/ports/discord-link-verify-record.repository.port';
import { Inject } from '@nestjs/common';

const DEFAULT_RECONCILE_AGE_MS = 60_000;
const DEFAULT_MAX_RECORD_AGE_MS = 3_600_000;
const RECONCILE_MAX_ATTEMPTS = 3;
const RECONCILE_BASE_BACKOFF_MS = 1_000;

/**
 * Reconciliation for the crash window between WISPACE token verify and the
 * local mapping upsert (#137 item 1). Every 5 minutes (advisory-locked):
 * - mapping already committed → consume the verify record;
 * - mapping missing → re-commit it from the stored userId, then consume;
 * - record older than the max age with no mapping → error + drop (the
 *   user retries the flow with a fresh token next time).
 */
@Injectable()
export class DiscordLinkReconcileCronService {
  private readonly logger = new Logger(DiscordLinkReconcileCronService.name);

  constructor(
    @Inject(DISCORD_LINK_VERIFY_RECORD_REPOSITORY)
    private readonly verifyRecordService: DiscordLinkVerifyRecordRepositoryPort,
    private readonly accountLinkService: DiscordAccountLinkService,
    private readonly configService: ConfigService,
    private readonly pgLock: PgAdvisoryLockService,
    private readonly relinkNotifier: DiscordRelinkNotifier,
  ) {}

  @Cron('*/5 * * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleReconcile(): Promise<void> {
    const result = await this.pgLock.withLock(
      ADVISORY_LOCKS.DISCORD_LINK_RECONCILE,
      () => this.runReconcileBatch(),
    );

    if (result === null) {
      this.logger.debug(
        'discord-link-reconcile skipped — lock held by another pod',
      );
    }
  }

  private async runReconcileBatch(): Promise<void> {
    const staleAgeMs = this.readPositiveInt(
      'DISCORD_LINK_RECONCILE_AGE_MS',
      DEFAULT_RECONCILE_AGE_MS,
    );
    const maxRecordAgeMs = this.readPositiveInt(
      'DISCORD_LINK_RECONCILE_MAX_AGE_MS',
      DEFAULT_MAX_RECORD_AGE_MS,
    );

    const records = await this.verifyRecordService.listStaleRecords(staleAgeMs);
    if (records.length === 0) {
      return;
    }

    let reconciled = 0;
    let alreadyCommitted = 0;
    let dropped = 0;
    let failed = 0;

    for (const record of records) {
      const existingUserId =
        await this.accountLinkService.findUserIdByDiscordId(
          record.discordUserId,
        );

      if (existingUserId !== undefined) {
        // Mapping committed — the record is a leftover (consume raced).
        await this.verifyRecordService.consumeRecord(record.discordUserId);
        alreadyCommitted += 1;
        continue;
      }

      if (Date.now() - record.verifiedAt.getTime() >= maxRecordAgeMs) {
        this.logger.error(
          `Discord link verify record older than ${maxRecordAgeMs}ms with no mapping — dropping discordUserId=${maskExternalId(
            record.discordUserId,
          )} (user must retry with a fresh token)`,
        );
        await this.verifyRecordService.consumeRecord(record.discordUserId);
        dropped += 1;
        continue;
      }

      try {
        const result = await this.upsertWithRetry(
          record.userId,
          record.discordUserId,
        );
        await this.verifyRecordService.consumeRecord(record.discordUserId);
        this.logger.log(
          `Reconciled Discord link discordUserId=${maskExternalId(
            record.discordUserId,
          )} userId=${maskExternalId(record.userId)}`,
        );
        if (result.relinked) {
          // #137 item 5: the re-committed mapping displaced a different
          // WISPACE user — notify the account holder (same as the callback path).
          await this.relinkNotifier.notify(
            record.discordUserId,
            result.previousUserId,
          );
        }
        reconciled += 1;
      } catch (error) {
        failed += 1;
        this.logger.error(
          `Discord link reconciliation failed for discordUserId=${maskExternalId(
            record.discordUserId,
          )}: ${errorMessage(error)}`,
        );
      }
    }

    this.logger.log(
      `Discord link reconcile batch: records=${records.length} reconciled=${reconciled} alreadyCommitted=${alreadyCommitted} dropped=${dropped} failed=${failed}`,
    );
  }

  private async upsertWithRetry(
    userId: number,
    discordUserId: string,
  ): Promise<{ relinked: boolean; previousUserId?: number }> {
    return retryWithBackoff(
      () => this.accountLinkService.upsertLink(userId, discordUserId),
      RECONCILE_MAX_ATTEMPTS,
      RECONCILE_BASE_BACKOFF_MS,
    );
  }

  private readPositiveInt(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }
}
