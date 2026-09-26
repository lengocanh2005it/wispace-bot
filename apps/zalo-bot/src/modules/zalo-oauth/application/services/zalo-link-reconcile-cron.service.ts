import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { Counter } from 'prom-client';
import {
  LinkReconcileCronCore,
  readPositiveInteger,
} from '@wispace/account-link-core/core';
import type {
  LinkReconcileBatchResult,
  LinkReconcileContext,
} from '@wispace/account-link-core/core';
import { PgAdvisoryLockService } from '@wispace/bot-common/locks';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import {
  ZALO_LINK_VERIFY_RECORD_REPOSITORY,
  type ZaloLinkVerifyRecordRepositoryPort,
} from '../../domain/ports/zalo-link-verify-record.repository.port';
import { ZaloAccountLinkService } from './zalo-account-link.service';
import {
  CLARIFICATION_STATE_STORE,
  type ClarificationStateStore,
} from '@wispace/chat-agent';
import { PlatformLinkStateService } from '@wispace/database';
import { WispaceLinkStatusClient } from '@wispace/wispace-client/core';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import { BotMetricsService } from '@wispace/bot-metrics';
import { ZaloRelinkNotifier } from './zalo-relink-notifier.service';
import { ZaloWelcomeService } from './zalo-welcome.service';

const DEFAULT_RECONCILE_AGE_MS = 120_000;
const DEFAULT_MAX_RECORD_AGE_MS = 10 * 60_000;
const ZALO_LINK_RECONCILE_LOCK = 884_200_937;
const LINK_RECONCILE_EXPECTED_INTERVAL_MS = 5 * 60 * 1000;

const reconcileRecordsTotal = new Counter({
  name: 'zalo_link_reconcile_records_total',
  help: 'Records processed by Zalo link reconciliation',
  labelNames: ['outcome'] as const,
});

/** Thin scheduled adapter around the shared account-link reconcile runner. */
@Injectable()
export class ZaloLinkReconcileCronService {
  private readonly logger = new Logger(ZaloLinkReconcileCronService.name);
  private readonly core: LinkReconcileCronCore;

  constructor(
    @Inject(ZALO_LINK_VERIFY_RECORD_REPOSITORY)
    private readonly verifyRecordService: ZaloLinkVerifyRecordRepositoryPort,
    private readonly accountLinkService: ZaloAccountLinkService,
    private readonly configService: ConfigService,
    private readonly pgLock: PgAdvisoryLockService,
    @Inject(CLARIFICATION_STATE_STORE)
    private readonly clarificationStateStore: ClarificationStateStore,
    @Optional() private readonly linkState?: PlatformLinkStateService,
    @Optional() private readonly linkStatusClient?: WispaceLinkStatusClient,
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redisClient?: RedisClientPort,
    @Optional() private readonly metrics?: BotMetricsService,
    @Optional() private readonly welcomeService?: ZaloWelcomeService,
    @Optional() private readonly relinkNotifier?: ZaloRelinkNotifier,
  ) {
    this.core = new LinkReconcileCronCore({
      listStaleRecords: async (olderThanMs) => {
        const records =
          await this.verifyRecordService.listStaleRecords(olderThanMs);
        return records.map((record) => ({
          externalUserId: record.zaloUserId,
          userId: record.userId,
          intentGeneration: record.intentGeneration,
          verifiedAt: record.verifiedAt,
          mappingObservation: record.mappingObservation,
        }));
      },
      findUserId: (externalUserId) =>
        this.accountLinkService.findUserIdByZaloId(externalUserId),
      getLinkState: async (externalUserId) => {
        const state = await this.linkState?.getLink('zalo', externalUserId);
        return state
          ? {
              state: state.state,
              generation: state.generation,
              revokedAt: state.revokedAt,
            }
          : undefined;
      },
      isFreshRelink: (externalUserId, userId) =>
        this.isFreshRelink(externalUserId, userId),
      upsertLink: (userId, externalUserId, mappingObservation) =>
        this.accountLinkService.upsertLink(
          userId,
          externalUserId,
          mappingObservation,
        ),
      consumeRecord: (intent) =>
        this.verifyRecordService.consumeRecord({
          zaloUserId: intent.externalUserId,
          userId: intent.userId,
          intentGeneration: intent.intentGeneration,
        }),
      clearClarification: (externalUserId) =>
        this.clearClarificationState(externalUserId),
      reconcileLinkStatus: () => this.runLinkStatusReconcile(),
    });
    this.metrics?.registerCron?.(
      'zalo-link-reconcile',
      LINK_RECONCILE_EXPECTED_INTERVAL_MS,
    );
  }

  @Cron('*/5 * * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleReconcile(): Promise<void> {
    const result = await this.pgLock.withLock(ZALO_LINK_RECONCILE_LOCK, () =>
      this.runReconcileWithStatus(),
    );

    if (result === null) {
      this.logger.debug(
        'zalo-link-reconcile skipped — lock held by another pod',
      );
    } else {
      this.metrics?.recordCronSuccess?.('zalo-link-reconcile');
    }
  }

  private async runReconcileWithStatus(): Promise<LinkReconcileBatchResult> {
    return this.core.run({
      staleAgeMs: readPositiveInteger(
        this.configService.get<string>('ZALO_LINK_RECONCILE_AGE_MS'),
        DEFAULT_RECONCILE_AGE_MS,
      ),
      maxRecordAgeMs: readPositiveInteger(
        this.configService.get<string>('ZALO_LINK_RECONCILE_MAX_AGE_MS'),
        DEFAULT_MAX_RECORD_AGE_MS,
      ),
      onOutcome: (outcome, record, error) => {
        reconcileRecordsTotal.inc({ outcome });
        if (error) {
          this.logger.warn(
            `Zalo link reconcile failed for zaloUserId=${maskExternalId(
              record.externalUserId,
            )}: ${errorMessage(error, record.externalUserId)}`,
          );
        }
      },
      onMismatch: (record, existingUserId) => {
        this.logger.warn(
          `Zalo link reconcile mismatch: verified intent for userId=${maskExternalId(
            record.userId,
          )} but existing mapping has userId=${maskExternalId(
            existingUserId,
          )} for zaloUserId=${maskExternalId(record.externalUserId)}`,
        );
      },
      onDropped: (record, reason) => {
        this.logger.error(
          `Zalo link verify record dropped for zaloUserId=${maskExternalId(
            record.externalUserId,
          )}: ${reason}`,
        );
      },
      onReconciled: (context) => this.afterReconciled(context),
      onBestEffortError: (_step, error) => {
        this.logger.warn(
          `Zalo link reconcile side effect failed: ${errorMessage(error)}`,
        );
      },
    });
  }

  private async afterReconciled({
    record,
    linkResult,
  }: LinkReconcileContext): Promise<void> {
    this.logger.log(
      `Zalo link reconciled for zaloUserId=${maskExternalId(
        record.externalUserId,
      )} (crash recovery)`,
    );
    if (linkResult.relinked && this.relinkNotifier) {
      try {
        await this.relinkNotifier.notify(record.externalUserId, record.userId);
      } catch (error: unknown) {
        this.logger.warn(
          `Zalo relink notification failed for zaloUserId=${maskExternalId(
            record.externalUserId,
          )}: ${errorMessage(error, record.externalUserId)}`,
        );
      }
    }
    if (this.welcomeService) {
      await this.welcomeService.welcomeIfDue(
        record.externalUserId,
        record.userId,
      );
    }
  }

  private async runLinkStatusReconcile(): Promise<void> {
    if (!this.linkState || !this.linkStatusClient?.enabled) return;
    const totals = await this.linkState.reconcile(
      'zalo',
      this.linkStatusClient,
      {
        onRevoked: (externalUserId) => this.clearRevokedState(externalUserId),
        onUnknown: (externalUserId) =>
          this.clearRevokedState(externalUserId, false, false),
      },
    );
    this.metrics?.incPlatformLinkTransition('zalo', 'revoked', totals.revoked);
    this.metrics?.incPlatformLinkTransition('zalo', 'unknown', totals.unknown);
    this.metrics?.incPlatformLinkTransition(
      'zalo',
      'recovered',
      totals.recovered,
    );
    this.metrics?.incPlatformLinkTransition(
      'zalo',
      'stale_writer',
      totals.staleWriter,
    );
  }

  private async clearRevokedState(
    externalUserId: string,
    invalidateVerifyIntent = true,
    clearQueuedWork = true,
  ): Promise<void> {
    if (invalidateVerifyIntent) {
      await this.verifyRecordService
        .discardRecord(externalUserId)
        .catch(() => undefined);
    }
    await this.clarificationStateStore
      .clear(`zalo:${externalUserId}`)
      .catch(() => undefined);
    try {
      await this.redisClient
        ?.getNativeClient()
        ?.del(
          `chat-history:zalo:${externalUserId}`,
          ...(clearQueuedWork
            ? [`chat:queue:zalo:buffer:${externalUserId}`]
            : []),
        );
    } catch {
      // Cache eviction is best effort; the DB state remains authoritative.
    }
  }

  private async isFreshRelink(
    zaloUserId: string,
    userId: number,
  ): Promise<boolean> {
    if (!this.linkStatusClient?.enabled) return false;
    const status = await this.linkStatusClient.getStatus(zaloUserId);
    return status.kind === 'active' && status.userId === userId;
  }

  private async clearClarificationState(zaloUserId: string): Promise<void> {
    try {
      await this.clarificationStateStore.clear(`zalo:${zaloUserId}`);
    } catch (error: unknown) {
      this.logger.warn(
        `Zalo clarification state clear after link reconcile failed for zaloUserId=${maskExternalId(zaloUserId)}: ${errorMessage(error, zaloUserId)}`,
      );
    }
  }
}
