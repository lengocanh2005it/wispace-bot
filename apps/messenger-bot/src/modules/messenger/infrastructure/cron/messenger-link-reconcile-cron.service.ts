import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Counter } from 'prom-client';
import {
  errorMessage,
  maskExternalId,
  maskExternalIdInText,
} from '@wispace/bot-common/masking';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { runLockedTick } from '@wispace/bot-common/cron';
import type { LockedTickItem } from '@wispace/bot-common/cron';
import { readEnvPositiveInt } from '@wispace/bot-common/config';
import { ADVISORY_LOCK } from '@messenger/shared/common/advisory-lock-ids';
import {
  MESSENGER_LINK_VERIFY_RECORD_REPOSITORY,
  type MessengerLinkVerifyRecordRepositoryPort,
} from '../../domain/ports/messenger-link-verify-record.repository.port';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerMappingRepositoryPort } from '../../domain/repositories/messenger-mapping.repository.port';
import {
  PLATFORM_LINK_STATE,
  type PlatformLinkStatePort,
} from '@wispace/account-link-core/core';
import { WispaceLinkStatusClient } from '@wispace/wispace-client/core';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import {
  CLARIFICATION_STATE_STORE,
  type ClarificationStateStore,
} from '@wispace/chat-agent';
import { BotMetricsService } from '@wispace/bot-metrics';
import { MessengerMappingService } from '../../application/services/messenger-mapping.service';

const DEFAULT_RECONCILE_AGE_MS = 60_000;
const DEFAULT_MAX_RECORD_AGE_MS = 3_600_000;
const LINK_RECONCILE_EXPECTED_INTERVAL_MS = 5 * 60 * 1000;

type LinkReconcileItemDetail =
  | 'reconciled'
  | 'already_committed'
  | 'identity_mismatch'
  | 'dropped'
  | 'failed';

const reconcileRecordsTotal = new Counter({
  name: 'messenger_link_reconcile_records_total',
  help: 'Records processed by Messenger link reconciliation',
  labelNames: ['outcome'] as const,
});

/**
 * Reconciliation for the crash window between WISPACE token verify and the
 * local mapping upsert (#384). Every 5 minutes (advisory-locked):
 * - mapping already committed → restore metadata and complete the verify record;
 * - mapping missing → claim the intent, re-commit it from the stored userId,
 *   restore metadata, then complete;
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
    private readonly mappingService: MessengerMappingService,
    private readonly configService: ConfigService,
    private readonly pgLock: PgAdvisoryLockService,
    @Optional()
    @Inject(PLATFORM_LINK_STATE)
    private readonly linkState?: PlatformLinkStatePort,
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
    await runLockedTick({
      name: 'messenger-link-reconcile',
      withLock: (run) =>
        this.pgLock.withLock(ADVISORY_LOCK.MESSENGER_LINK_RECONCILE, run),
      run: async () => {
        await this.runLinkStatusReconcile();
        return this.runReconcileBatch();
      },
      metrics: this.metrics,
      logger: this.logger,
    });
  }

  private async runReconcileBatch(): Promise<
    LockedTickItem<LinkReconcileItemDetail>[]
  > {
    const staleAgeMs = this.readPositiveInt(
      'MESSENGER_LINK_RECONCILE_AGE_MS',
      DEFAULT_RECONCILE_AGE_MS,
    );
    const maxRecordAgeMs = this.readPositiveInt(
      'MESSENGER_LINK_RECONCILE_MAX_AGE_MS',
      DEFAULT_MAX_RECORD_AGE_MS,
    );

    await this.verifyRecordService
      .cleanupCommittedRecords(maxRecordAgeMs)
      .catch((error: unknown) => {
        this.logger.error(
          `Messenger committed link intent cleanup failed: ${maskExternalIdInText(
            errorMessage(error),
            '',
          )}`,
        );
      });

    const records = await this.verifyRecordService.listStaleRecords(staleAgeMs);
    if (records.length === 0) {
      return [];
    }

    let reconciled = 0;
    let alreadyCommitted = 0;
    let identityMismatch = 0;
    let dropped = 0;
    let failed = 0;
    const items: LockedTickItem<LinkReconcileItemDetail>[] = [];

    for (const record of records) {
      let item: LockedTickItem<LinkReconcileItemDetail> = {
        outcome: 'failed',
        details: 'failed',
      };
      try {
        const existingMapping =
          await this.mappingRepository.findActiveMappingByPsid(record.psid);
        const existingState = await this.linkState?.getLink(
          'messenger',
          record.psid,
        );

        if (existingMapping) {
          try {
            if (existingMapping.userId !== record.userId) {
              if (Date.now() - record.verifiedAt.getTime() >= maxRecordAgeMs) {
                await this.verifyRecordService.discardRecord(
                  record.psid,
                  record.intentGeneration,
                );
                dropped += 1;
                reconcileRecordsTotal.inc({
                  outcome: 'identity_conflict_expired',
                });
                item = { outcome: 'succeeded', details: 'dropped' };
              } else {
                identityMismatch += 1;
                reconcileRecordsTotal.inc({ outcome: 'identity_mismatch' });
                item = { outcome: 'skipped', details: 'identity_mismatch' };
              }
              continue;
            }

            const completion = await this.mappingService.linkFromContext(
              record.psid,
              {
                ref: record.refFingerprint ?? '',
                userId: record.userId,
                topic: record.topic,
                cadence: record.cadence,
              },
              {
                notifyUser: false,
                intentGeneration: record.intentGeneration,
              },
            );
            if (completion.blocked) {
              failed += 1;
              reconcileRecordsTotal.inc({
                outcome: this.reconcileOutcomeForCompletion(completion),
              });
              item = { outcome: 'failed', details: 'failed' };
              continue;
            }

            alreadyCommitted += 1;
            reconcileRecordsTotal.inc({ outcome: 'already_committed' });
            item = { outcome: 'succeeded', details: 'already_committed' };
          } catch (error) {
            failed += 1;
            reconcileRecordsTotal.inc({ outcome: 'failed' });
            this.logger.error(
              `Messenger link reconciliation failed for psid=${maskExternalId(
                record.psid,
              )}: ${maskExternalIdInText(errorMessage(error), record.psid)}`,
            );
            item = { outcome: 'failed', details: 'failed' };
          }
          continue;
        }

        if (Date.now() - record.verifiedAt.getTime() >= maxRecordAgeMs) {
          this.logger.error(
            `Messenger link verify record older than ${maxRecordAgeMs}ms with no mapping — dropping psid=${maskExternalId(
              record.psid,
            )} (user must retry with a fresh token)`,
          );
          await this.verifyRecordService.discardRecord(
            record.psid,
            record.intentGeneration,
          );
          dropped += 1;
          reconcileRecordsTotal.inc({ outcome: 'dropped' });
          item = { outcome: 'succeeded', details: 'dropped' };
          continue;
        }

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
          await this.verifyRecordService.discardRecord(
            record.psid,
            record.intentGeneration,
          );
          dropped += 1;
          reconcileRecordsTotal.inc({ outcome: 'stale_writer' });
          item = { outcome: 'succeeded', details: 'dropped' };
          continue;
        }

        try {
          const completion = await this.mappingService.linkFromContext(
            record.psid,
            {
              ref: record.refFingerprint ?? '',
              userId: record.userId,
              topic: record.topic,
              cadence: record.cadence,
            },
            {
              notifyUser: false,
              intentGeneration: record.intentGeneration,
            },
          );
          if (completion.blocked) {
            failed += 1;
            reconcileRecordsTotal.inc({
              outcome: this.reconcileOutcomeForCompletion(completion),
            });
            item = { outcome: 'failed', details: 'failed' };
            continue;
          }
          this.logger.log(
            `Reconciled Messenger link psid=${maskExternalId(
              record.psid,
            )} userId=${maskExternalId(String(record.userId))}`,
          );
          reconciled += 1;
          reconcileRecordsTotal.inc({ outcome: 'reconciled' });
          item = { outcome: 'succeeded', details: 'reconciled' };
        } catch (error) {
          failed += 1;
          reconcileRecordsTotal.inc({ outcome: 'failed' });
          this.logger.error(
            `Messenger link reconciliation failed for psid=${maskExternalId(
              record.psid,
            )}: ${maskExternalIdInText(errorMessage(error), record.psid)}`,
          );
          item = { outcome: 'failed', details: 'failed' };
        }
      } catch (error) {
        failed += 1;
        reconcileRecordsTotal.inc({ outcome: 'failed' });
        this.logger.error(
          `Messenger link reconciliation failed for psid=${maskExternalId(
            record.psid,
          )}: ${maskExternalIdInText(errorMessage(error), record.psid)}`,
        );
        item = { outcome: 'failed', details: 'failed' };
      } finally {
        items.push(item);
      }
    }

    this.logger.log(
      `Messenger link reconcile batch: records=${records.length} reconciled=${reconciled} alreadyCommitted=${alreadyCommitted} identityMismatch=${identityMismatch} dropped=${dropped} failed=${failed}`,
    );
    return items;
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
        .discardRecord(externalUserId)
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

  private reconcileOutcomeForCompletion(completion: {
    intentOutcome?:
      | 'claimed'
      | 'committed'
      | 'already_processing'
      | 'already_committed'
      | 'stale'
      | 'claim_failed'
      | 'complete_failed';
  }): 'mapping_cas_blocked' | 'consume_mismatch' | 'failed' {
    switch (completion.intentOutcome) {
      case 'stale':
        return 'consume_mismatch';
      case 'claim_failed':
      case 'complete_failed':
        return 'failed';
      default:
        return 'mapping_cas_blocked';
    }
  }

  private readPositiveInt(key: string, fallback: number): number {
    return readEnvPositiveInt(this.configService, key, fallback);
  }
}
