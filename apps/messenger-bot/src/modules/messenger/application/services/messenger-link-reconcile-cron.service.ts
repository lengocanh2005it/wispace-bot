import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Counter } from 'prom-client';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { ADVISORY_LOCK } from '@messenger/shared/common/advisory-lock-ids';
import {
  MESSENGER_LINK_VERIFY_RECORD_REPOSITORY,
  type MessengerLinkVerifyRecordRepositoryPort,
} from '../../domain/ports/messenger-link-verify-record.repository.port';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';
import { PlatformLinkStateService } from '@wispace/database';
import { WispaceLinkStatusClient } from '@wispace/wispace-client';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import {
  CLARIFICATION_STATE_STORE,
  type ClarificationStateStore,
} from '@wispace/chat-agent';
import { BotMetricsService } from '@wispace/bot-metrics';

const DEFAULT_RECONCILE_AGE_MS = 60_000;
const DEFAULT_MAX_RECORD_AGE_MS = 3_600_000;
const LINK_RECONCILE_EXPECTED_INTERVAL_MS = 5 * 60 * 1000;

const reconcileRecordsTotal = new Counter({
  name: 'messenger_link_reconcile_records_total',
  help: 'Records processed by Messenger link reconciliation',
  labelNames: ['outcome'] as const,
});

/**
 * Reconciliation for the crash window between WISPACE token verify and the
 * local mapping upsert (#384). Every 5 minutes (advisory-locked):
 * - mapping already committed → consume the verify record;
 * - mapping missing → re-commit it from the stored userId, then consume;
 * - record older than the max age with no mapping → error + drop (the
 *   user retries the flow with a fresh token next time).
 */
@Injectable()
export class MessengerLinkReconcileCronService {
  private readonly logger = new Logger(MessengerLinkReconcileCronService.name);

  constructor(
    @Inject(MESSENGER_LINK_VERIFY_RECORD_REPOSITORY)
    private readonly verifyRecordService: MessengerLinkVerifyRecordRepositoryPort,
    @Inject(MESSENGER_REPOSITORY)
    private readonly mappingRepository: MessengerMappingRepositoryPort,
    private readonly configService: ConfigService,
    private readonly pgLock: PgAdvisoryLockService,
    @Optional() private readonly linkState?: PlatformLinkStateService,
    @Optional() private readonly linkStatusClient?: WispaceLinkStatusClient,
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redisClient?: RedisClientPort,
    @Optional()
    @Inject(CLARIFICATION_STATE_STORE)
    private readonly clarificationStateStore?: ClarificationStateStore,
    @Optional() private readonly metrics?: BotMetricsService,
  ) {
    this.metrics?.registerCron?.(
      'messenger-link-reconcile',
      LINK_RECONCILE_EXPECTED_INTERVAL_MS,
    );
  }

  @Cron('*/5 * * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleReconcile(): Promise<void> {
    const result = await this.pgLock.withLock(
      ADVISORY_LOCK.MESSENGER_LINK_RECONCILE,
      async () => {
        await this.runLinkStatusReconcile();
        await this.runReconcileBatch();
      },
    );

    if (result === null) {
      this.logger.debug(
        'messenger-link-reconcile skipped — lock held by another pod',
      );
    } else {
      this.metrics?.recordCronSuccess?.('messenger-link-reconcile');
    }
  }

  private async runReconcileBatch(): Promise<void> {
    const staleAgeMs = this.readPositiveInt(
      'MESSENGER_LINK_RECONCILE_AGE_MS',
      DEFAULT_RECONCILE_AGE_MS,
    );
    const maxRecordAgeMs = this.readPositiveInt(
      'MESSENGER_LINK_RECONCILE_MAX_AGE_MS',
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
      const existingMapping =
        await this.mappingRepository.findActiveMappingByPsid(record.psid);

      if (existingMapping) {
        await this.verifyRecordService.consumeRecord(record.psid);
        alreadyCommitted += 1;
        reconcileRecordsTotal.inc({ outcome: 'already_committed' });
        continue;
      }

      if (Date.now() - record.verifiedAt.getTime() >= maxRecordAgeMs) {
        this.logger.error(
          `Messenger link verify record older than ${maxRecordAgeMs}ms with no mapping — dropping psid=${maskExternalId(
            record.psid,
          )} (user must retry with a fresh token)`,
        );
        await this.verifyRecordService.consumeRecord(record.psid);
        dropped += 1;
        reconcileRecordsTotal.inc({ outcome: 'dropped' });
        continue;
      }

      const existingState = await this.linkState?.getLink(
        'messenger',
        record.psid,
      );
      if (
        existingState &&
        (existingState.state === 'confirmed-revoked' ||
          (existingState.state !== 'active' &&
            (existingState.state === 'locally-unlinked' &&
            existingState.revokedAt &&
            record.verifiedAt <= existingState.revokedAt
              ? true
              : !(await this.isFreshRelink(record.psid, record.userId)))))
      ) {
        await this.verifyRecordService.consumeRecord(record.psid);
        dropped += 1;
        reconcileRecordsTotal.inc({ outcome: 'stale_writer' });
        continue;
      }

      try {
        // Re-commit the mapping with just psid+userId (topic/cadence
        // will be COALESCEd to null on first commit; the user can refine
        // via a fresh link flow).
        await this.mappingRepository.upsertPsidUserLink({
          psid: record.psid,
          userId: record.userId,
          ...(existingState?.generation
            ? { expectedGeneration: existingState.generation }
            : {}),
        });
        await this.verifyRecordService.consumeRecord(record.psid);
        this.logger.log(
          `Reconciled Messenger link psid=${maskExternalId(
            record.psid,
          )} userId=${maskExternalId(String(record.userId))}`,
        );
        reconciled += 1;
        reconcileRecordsTotal.inc({ outcome: 'reconciled' });
      } catch (error) {
        failed += 1;
        reconcileRecordsTotal.inc({ outcome: 'failed' });
        this.logger.error(
          `Messenger link reconciliation failed for psid=${maskExternalId(
            record.psid,
          )}: ${errorMessage(error)}`,
        );
      }
    }

    this.logger.log(
      `Messenger link reconcile batch: records=${records.length} reconciled=${reconciled} alreadyCommitted=${alreadyCommitted} dropped=${dropped} failed=${failed}`,
    );
  }

  private async runLinkStatusReconcile(): Promise<void> {
    if (!this.linkState || !this.linkStatusClient?.enabled) return;
    const totals = await this.linkState.reconcile(
      'messenger',
      this.linkStatusClient,
      {
        onRevoked: (externalUserId, userId) =>
          this.clearRevokedState(externalUserId, userId),
        onUnknown: (externalUserId, userId) =>
          this.clearRevokedState(externalUserId, userId, false, false),
      },
    );
    this.metrics?.incPlatformLinkTransition(
      'messenger',
      'revoked',
      totals.revoked,
    );
    this.metrics?.incPlatformLinkTransition(
      'messenger',
      'unknown',
      totals.unknown,
    );
    this.metrics?.incPlatformLinkTransition(
      'messenger',
      'recovered',
      totals.recovered,
    );
    this.metrics?.incPlatformLinkTransition(
      'messenger',
      'stale_writer',
      totals.staleWriter,
    );
  }

  private async clearRevokedState(
    externalUserId: string,
    userId?: number,
    invalidateVerifyIntent = true,
    clearQueuedWork = true,
  ): Promise<void> {
    if (invalidateVerifyIntent) {
      await this.verifyRecordService
        .consumeRecord(externalUserId)
        .catch(() => undefined);
    }
    await this.clarificationStateStore
      ?.clear(`messenger:${externalUserId}`)
      .catch(() => undefined);
    try {
      await this.redisClient
        ?.getNativeClient()
        ?.del(
          `chat:history:${externalUserId}`,
          ...(clearQueuedWork ? [`chat:queue:buffer:${externalUserId}`] : []),
          ...(userId !== undefined
            ? [`cache:user:display:messenger:${userId}`]
            : []),
        );
    } catch {
      // Cache eviction is best effort; the DB state remains authoritative.
    }
  }

  private async isFreshRelink(psid: string, userId: number): Promise<boolean> {
    if (!this.linkStatusClient?.enabled) return false;
    const status = await this.linkStatusClient.getStatus(psid);
    return status.kind === 'active' && status.userId === userId;
  }

  private readPositiveInt(key: string, fallback: number): number {
    const raw = this.configService.get<string>(key);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : fallback;
  }
}
