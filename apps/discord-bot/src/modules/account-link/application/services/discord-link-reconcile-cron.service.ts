import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Counter } from 'prom-client';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { DiscordAccountLinkService } from './discord-account-link.service';
import { DiscordGuildMembershipService } from './discord-guild-membership.service';
import { DiscordRelinkNotifier } from './discord-relink-notifier.service';
import { DiscordWelcomeService } from './discord-welcome.service';
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

const reconcileRecordsTotal = new Counter({
  name: 'discord_link_reconcile_records_total',
  help: 'Records processed by Discord link reconciliation',
  labelNames: ['outcome'] as const,
});

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
    private readonly guildMembershipService: DiscordGuildMembershipService,
    private readonly welcomeService: DiscordWelcomeService,
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
      const isStale =
        Date.now() - record.verifiedAt.getTime() >= maxRecordAgeMs;
      const existingUserId =
        await this.accountLinkService.findUserIdByDiscordId(
          record.discordUserId,
        );

      if (existingUserId === record.userId) {
        // Mapping committed — the record is a leftover (consume raced).
        await this.verifyRecordService.consumeRecord(record.discordUserId);
        alreadyCommitted += 1;
        reconcileRecordsTotal.inc({ outcome: 'already_committed' });
        continue;
      }

      if (existingUserId !== undefined) {
        this.logger.warn(
          `Discord link reconcile mismatch: verified intent for userId=${maskExternalId(record.userId)} but existing mapping has userId=${maskExternalId(existingUserId)} for discordUserId=${maskExternalId(record.discordUserId)}`,
        );
        reconcileRecordsTotal.inc({ outcome: 'mismatched' });

        if (isStale) {
          await this.dropRecord(
            record.discordUserId,
            `older than ${maxRecordAgeMs}ms with mismatched mapping`,
          );
          dropped += 1;
        }
        continue;
      }

      if (isStale) {
        await this.dropRecord(
          record.discordUserId,
          `older than ${maxRecordAgeMs}ms with no mapping (user must retry with a fresh token)`,
        );
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

        // #137 item 4: the user may have joined while the mapping was
        // missing (the gateway skipped the organic welcome because a fresh
        // verify intent existed) — deliver the linked welcome now.
        if (await this.guildMembershipService.isMember(record.discordUserId)) {
          await this.welcomeService.welcomeIfDue(record.discordUserId);
        }
        reconciled += 1;
        reconcileRecordsTotal.inc({ outcome: 'reconciled' });
      } catch (error) {
        failed += 1;
        reconcileRecordsTotal.inc({ outcome: 'failed' });
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

  private async dropRecord(
    discordUserId: string,
    reason: string,
  ): Promise<void> {
    this.logger.error(
      `Discord link verify record dropped for discordUserId=${maskExternalId(discordUserId)}: ${reason}`,
    );
    await this.verifyRecordService.consumeRecord(discordUserId);
    reconcileRecordsTotal.inc({ outcome: 'dropped' });
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
