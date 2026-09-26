import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { Counter } from 'prom-client';
import {
  LinkReconcileCronCore,
  readPositiveInteger,
} from '@wispace/account-link-core/core';
import type {
  LinkReconcileBatchResult,
  LinkReconcileContext,
} from '@wispace/account-link-core/core';
import {
  ADVISORY_LOCKS,
  PgAdvisoryLockService,
} from '@wispace/bot-common/locks';
import { errorMessage, maskExternalId } from '@wispace/bot-common/masking';
import { DiscordAccountLinkService } from './discord-account-link.service';
import {
  DISCORD_GUILD_MEMBERSHIP,
  type DiscordGuildMembershipPort,
} from '../../domain/ports/discord-guild-membership.port';
import { DiscordRelinkNotifier } from './discord-relink-notifier.service';
import { DiscordWelcomeService } from './discord-welcome.service';
import {
  DISCORD_LINK_VERIFY_RECORD_REPOSITORY,
  type DiscordLinkVerifyRecordRepositoryPort,
} from '../../domain/ports/discord-link-verify-record.repository.port';
import {
  CLARIFICATION_STATE_STORE,
  type ClarificationStateStore,
} from '@wispace/chat-agent';
import { PlatformLinkStateService } from '@wispace/database';
import { WispaceLinkStatusClient } from '@wispace/wispace-client/core';
import { REDIS_CLIENT, type RedisClientPort } from '@wispace/bot-common/redis';
import { BotMetricsService } from '@wispace/bot-metrics';

const DEFAULT_RECONCILE_AGE_MS = 60_000;
const DEFAULT_MAX_RECORD_AGE_MS = 3_600_000;
const LINK_RECONCILE_EXPECTED_INTERVAL_MS = 5 * 60 * 1000;

const reconcileRecordsTotal = new Counter({
  name: 'discord_link_reconcile_records_total',
  help: 'Records processed by Discord link reconciliation',
  labelNames: ['outcome'] as const,
});

/** Thin scheduled adapter around the shared account-link reconcile runner. */
@Injectable()
export class DiscordLinkReconcileCronService {
  private readonly logger = new Logger(DiscordLinkReconcileCronService.name);
  private readonly core: LinkReconcileCronCore;

  constructor(
    @Inject(DISCORD_LINK_VERIFY_RECORD_REPOSITORY)
    private readonly verifyRecordService: DiscordLinkVerifyRecordRepositoryPort,
    private readonly accountLinkService: DiscordAccountLinkService,
    private readonly configService: ConfigService,
    private readonly pgLock: PgAdvisoryLockService,
    private readonly relinkNotifier: DiscordRelinkNotifier,
    @Inject(DISCORD_GUILD_MEMBERSHIP)
    private readonly guildMembershipService: DiscordGuildMembershipPort,
    private readonly welcomeService: DiscordWelcomeService,
    @Inject(CLARIFICATION_STATE_STORE)
    private readonly clarificationStateStore: ClarificationStateStore,
    @Optional() private readonly linkState?: PlatformLinkStateService,
    @Optional() private readonly linkStatusClient?: WispaceLinkStatusClient,
    @Optional()
    @Inject(REDIS_CLIENT)
    private readonly redisClient?: RedisClientPort,
    @Optional() private readonly metrics?: BotMetricsService,
  ) {
    this.core = new LinkReconcileCronCore({
      listStaleRecords: async (olderThanMs) => {
        const records =
          await this.verifyRecordService.listStaleRecords(olderThanMs);
        return records.map((record) => ({
          externalUserId: record.discordUserId,
          userId: record.userId,
          intentGeneration: record.intentGeneration,
          verifiedAt: record.verifiedAt,
          mappingObservation: record.mappingObservation,
        }));
      },
      findUserId: (externalUserId) =>
        this.accountLinkService.findUserIdByDiscordId(externalUserId),
      getLinkState: async (externalUserId) => {
        const state = await this.linkState?.getLink('discord', externalUserId);
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
          discordUserId: intent.externalUserId,
          userId: intent.userId,
          intentGeneration: intent.intentGeneration,
        }),
      clearClarification: (externalUserId) =>
        this.clearClarificationState(externalUserId),
      reconcileLinkStatus: () => this.runLinkStatusReconcile(),
    });
    this.metrics?.registerCron?.(
      'discord-link-reconcile',
      LINK_RECONCILE_EXPECTED_INTERVAL_MS,
    );
  }

  @Cron('*/5 * * * *', { timeZone: 'Asia/Ho_Chi_Minh' })
  async handleReconcile(): Promise<void> {
    const result = await this.pgLock.withLock(
      ADVISORY_LOCKS.DISCORD_LINK_RECONCILE,
      () => this.runReconcileWithStatus(),
    );

    if (result === null) {
      this.logger.debug(
        'discord-link-reconcile skipped — lock held by another pod',
      );
    } else {
      this.metrics?.recordCronSuccess?.('discord-link-reconcile');
    }
  }

  private async runReconcileWithStatus(): Promise<LinkReconcileBatchResult> {
    return this.core.run({
      staleAgeMs: readPositiveInteger(
        this.configService.get<string>('DISCORD_LINK_RECONCILE_AGE_MS'),
        DEFAULT_RECONCILE_AGE_MS,
      ),
      maxRecordAgeMs: readPositiveInteger(
        this.configService.get<string>('DISCORD_LINK_RECONCILE_MAX_AGE_MS'),
        DEFAULT_MAX_RECORD_AGE_MS,
      ),
      onOutcome: (outcome, record, error) => {
        reconcileRecordsTotal.inc({ outcome });
        if (error) {
          this.logger.error(
            `Discord link reconciliation failed for discordUserId=${maskExternalId(
              record.externalUserId,
            )}: ${errorMessage(error, record.externalUserId)}`,
          );
        }
      },
      onMismatch: (record, existingUserId) => {
        this.logger.warn(
          `Discord link reconcile mismatch: verified intent for userId=${maskExternalId(
            record.userId,
          )} but existing mapping has userId=${maskExternalId(
            existingUserId,
          )} for discordUserId=${maskExternalId(record.externalUserId)}`,
        );
      },
      onDropped: (record, reason) => {
        this.logger.error(
          `Discord link verify record dropped for discordUserId=${maskExternalId(
            record.externalUserId,
          )}: ${reason}`,
        );
      },
      onReconciled: (context) => this.afterReconciled(context),
      onBestEffortError: (_step, error) => {
        this.logger.warn(
          `Discord link reconcile side effect failed: ${errorMessage(error)}`,
        );
      },
    });
  }

  private async afterReconciled({
    record,
    linkResult,
  }: LinkReconcileContext): Promise<void> {
    this.logger.log(
      `Reconciled Discord link discordUserId=${maskExternalId(
        record.externalUserId,
      )} userId=${maskExternalId(record.userId)}`,
    );
    if (linkResult.relinked) {
      await this.relinkNotifier
        .notify(record.externalUserId, linkResult.previousUserId, record.userId)
        .catch((error: unknown) => {
          this.logger.warn(
            `Discord relink notification failed for discordUserId=${maskExternalId(
              record.externalUserId,
            )}: ${errorMessage(error, record.externalUserId)}`,
          );
        });
    }
    try {
      if (await this.guildMembershipService.isMember(record.externalUserId)) {
        await this.welcomeService.welcomeIfDue(
          record.externalUserId,
          undefined,
          record.userId,
        );
      }
    } catch (error: unknown) {
      this.logger.warn(
        `Discord reconciled welcome failed for discordUserId=${maskExternalId(
          record.externalUserId,
        )}: ${errorMessage(error, record.externalUserId)}`,
      );
    }
  }

  private async runLinkStatusReconcile(): Promise<void> {
    if (!this.linkState || !this.linkStatusClient?.enabled) return;
    const totals = await this.linkState.reconcile(
      'discord',
      this.linkStatusClient,
      {
        onRevoked: (externalUserId) => this.clearRevokedState(externalUserId),
        onUnknown: (externalUserId) =>
          this.clearRevokedState(externalUserId, false, false),
      },
    );
    this.metrics?.incPlatformLinkTransition(
      'discord',
      'revoked',
      totals.revoked,
    );
    this.metrics?.incPlatformLinkTransition(
      'discord',
      'unknown',
      totals.unknown,
    );
    this.metrics?.incPlatformLinkTransition(
      'discord',
      'recovered',
      totals.recovered,
    );
    this.metrics?.incPlatformLinkTransition(
      'discord',
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
      .clear(`discord:${externalUserId}`)
      .catch(() => undefined);
    try {
      await this.redisClient
        ?.getNativeClient()
        ?.del(
          `chat-history:discord:${externalUserId}`,
          ...(clearQueuedWork
            ? [`chat:queue:discord:buffer:${externalUserId}`]
            : []),
        );
    } catch {
      // Cache eviction is best effort; the DB state remains authoritative.
    }
  }

  private async isFreshRelink(
    discordUserId: string,
    userId: number,
  ): Promise<boolean> {
    if (!this.linkStatusClient?.enabled) return false;
    const status = await this.linkStatusClient.getStatus(discordUserId);
    return status.kind === 'active' && status.userId === userId;
  }

  private async clearClarificationState(discordUserId: string): Promise<void> {
    try {
      await this.clarificationStateStore.clear(`discord:${discordUserId}`);
    } catch (error: unknown) {
      this.logger.warn(
        `Discord clarification state clear after link reconcile failed for discordUserId=${maskExternalId(discordUserId)}: ${errorMessage(error, discordUserId)}`,
      );
    }
  }
}
