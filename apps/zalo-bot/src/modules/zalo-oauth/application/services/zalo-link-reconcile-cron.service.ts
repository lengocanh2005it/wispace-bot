import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Counter } from 'prom-client';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { maskExternalId } from '@wispace/bot-common/masking';
import {
  ZALO_LINK_VERIFY_RECORD_REPOSITORY,
  type ZaloLinkVerifyRecordRepositoryPort,
} from '../../domain/ports/zalo-link-verify-record.repository.port';
import { ZaloAccountLinkService } from './zalo-account-link.service';

const DEFAULT_RECONCILE_AGE_MS = 120_000;
const DEFAULT_MAX_RECORD_AGE_MS = 10 * 60_000;
const ZALO_LINK_RECONCILE_LOCK = 884_200_937;

const reconcileRecordsTotal = new Counter({
  name: 'zalo_link_reconcile_records_total',
  help: 'Records processed by Zalo link reconciliation',
  labelNames: ['outcome'] as const,
});

/**
 * Reconciles pending Zalo link verify-intents (#147, mirror of Discord's
 * discord-link-reconcile #137): a crash between token verification and the
 * local mapping upsert leaves WISPACE "linked" with no bot mapping — this
 * cron re-commits the mapping idempotently, then consumes the intent.
 */
@Injectable()
export class ZaloLinkReconcileCronService {
  private readonly logger = new Logger(ZaloLinkReconcileCronService.name);

  constructor(
    @Inject(ZALO_LINK_VERIFY_RECORD_REPOSITORY)
    private readonly verifyRecordService: ZaloLinkVerifyRecordRepositoryPort,
    private readonly accountLinkService: ZaloAccountLinkService,
    private readonly configService: ConfigService,
    private readonly pgLock: PgAdvisoryLockService,
  ) {}

  @Cron('*/5 * * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleReconcile(): Promise<void> {
    const result = await this.pgLock.withLock(ZALO_LINK_RECONCILE_LOCK, () =>
      this.runReconcileBatch(),
    );

    if (result === null) {
      this.logger.debug(
        'zalo-link-reconcile skipped — lock held by another pod',
      );
    }
  }

  private async runReconcileBatch(): Promise<void> {
    const staleAgeMs = this.readPositiveInt(
      'ZALO_LINK_RECONCILE_AGE_MS',
      DEFAULT_RECONCILE_AGE_MS,
    );
    const maxRecordAgeMs = this.readPositiveInt(
      'ZALO_LINK_RECONCILE_MAX_AGE_MS',
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
      try {
        const existingUserId = await this.accountLinkService.findUserIdByZaloId(
          record.zaloUserId,
        );

        if (existingUserId === record.userId) {
          // Mapping committed — the record is a leftover (consume raced).
          await this.verifyRecordService.consumeRecord(record.zaloUserId);
          alreadyCommitted += 1;
          reconcileRecordsTotal.inc({ outcome: 'already_committed' });
          continue;
        }

        if (existingUserId !== undefined) {
          this.logger.warn(
            `Zalo link reconcile mismatch: verified intent for userId=${maskExternalId(record.userId)} but existing mapping has userId=${maskExternalId(existingUserId)} for zaloUserId=${maskExternalId(record.zaloUserId)}`,
          );
          reconcileRecordsTotal.inc({ outcome: 'mismatched' });

          if (isStale) {
            await this.dropRecord(
              record.zaloUserId,
              `older than ${maxRecordAgeMs}ms with mismatched mapping`,
            );
            dropped += 1;
          }
          continue;
        }

        if (isStale) {
          await this.dropRecord(
            record.zaloUserId,
            `older than ${maxRecordAgeMs}ms with no mapping (user must retry with a fresh token)`,
          );
          dropped += 1;
          continue;
        }

        await this.accountLinkService.upsertLink(
          record.userId,
          record.zaloUserId,
        );
        await this.verifyRecordService.consumeRecord(record.zaloUserId);
        reconciled += 1;
        reconcileRecordsTotal.inc({ outcome: 'reconciled' });
        this.logger.log(
          `Zalo link reconciled for zaloUserId=${maskExternalId(record.zaloUserId)} (crash recovery)`,
        );
      } catch (error) {
        failed += 1;
        reconcileRecordsTotal.inc({ outcome: 'failed' });
        this.logger.warn(
          `Zalo link reconcile failed for zaloUserId=${maskExternalId(
            record.zaloUserId,
          )}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    this.logger.log(
      `zalo-link-reconcile done: reconciled=${reconciled}, alreadyCommitted=${alreadyCommitted}, dropped=${dropped}, failed=${failed}`,
    );
  }

  private async dropRecord(zaloUserId: string, reason: string): Promise<void> {
    this.logger.error(
      `Zalo link verify record dropped for zaloUserId=${maskExternalId(zaloUserId)}: ${reason}`,
    );
    await this.verifyRecordService.consumeRecord(zaloUserId);
    reconcileRecordsTotal.inc({ outcome: 'dropped' });
  }

  private readPositiveInt(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }
}
