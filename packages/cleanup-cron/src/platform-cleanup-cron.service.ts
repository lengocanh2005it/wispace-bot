import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { CronJob } from 'cron';
import { DataSource, LessThan, Repository } from 'typeorm';
import { ChatIdempotencyEntity } from '@wispace/chat-metering/adapters';
import { WebhookDeadLetterEntity } from '@wispace/database';
import type { Platform } from '@wispace/contracts';
import { readEnvPositiveInt } from '@wispace/bot-common/config';
import { subMinutes } from 'date-fns';
import { CleanupCronService } from './cleanup-cron.service';

export interface CleanupCronJobsConfig {
  /** Platform name ('discord' | 'zalo') — used for cron names and idempotency cleanup filter. */
  platform: Platform;
  /** Advisory lock IDs for multi-pod safety. */
  lockIds: {
    messageLog: number;
    deadLetter: number;
    idempotencyRecovery: number;
    idempotencyCleanup: number;
    /** Optional oauth state cleanup (wired by Discord and Zalo). */
    oauthState?: number;
    /** Report claims retention cleanup. */
    reportClaim?: number;
  };
  messageLogRepo: Repository<{ createdAt: Date; platform: string }>;
  deadLetterRepo: Repository<WebhookDeadLetterEntity>;
  idempotencyRepo: Repository<ChatIdempotencyEntity>;
  /** Optional oauth state cleanup repo. */
  oauthStateRepo?: Repository<{ createdAt: Date }>;
  /** Report claims retention cleanup repo (legacy per-platform table). */
  reportClaimRepo?: Repository<{ createdAt: Date }>;
  rateLimitService: {
    isEnabled(): boolean;
    recoverStuckReservedSlots(): Promise<{ recovered: string[] }>;
  };
  /** Optional per-bot heartbeat metrics for quota recovery. */
  metrics?: CleanupCronMetricsPort;
}

const CRON_TIMEZONE = 'Asia/Ho_Chi_Minh';

export interface CleanupCronMetricsPort {
  registerCron(name: string, expectedIntervalMs: number): void;
  recordCronSuccess(name: string): void;
}

/**
 * Platform-parameterized cleanup cron jobs shared by Discord and Zalo
 * (replaces their near-identical per-app cleanup cron services).
 *
 * Cron names are built from the platform (`${platform}-message-log-cleanup`,
 * ...) so each bot keeps its existing scheduler names. Jobs are registered
 * programmatically (not via @Cron) because decorator names are static.
 */
@Injectable()
export class PlatformCleanupCronService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PlatformCleanupCronService.name);
  private readonly config: CleanupCronJobsConfig;
  private readonly jobs = new Map<string, CronJob>();

  constructor(
    private readonly cleanupService: CleanupCronService,
    private readonly configService: ConfigService,
    @InjectDataSource() private readonly dataSource: DataSource,
    config: CleanupCronJobsConfig,
  ) {
    this.config = config;
  }

  onModuleInit(): void {
    if (this.config.rateLimitService.isEnabled()) {
      this.config.metrics?.registerCron(
        `${this.config.platform}-idempotency-recovery`,
        30 * 60 * 1000,
      );
    }
    this.register(
      `${this.config.platform}-message-log-cleanup`,
      '0 0 3 * * *',
      () => this.handleMessageLogCleanup(),
    );
    this.register(
      `${this.config.platform}-dead-letter-cleanup`,
      '0 30 3 * * *',
      () => this.handleDeadLetterCleanup(),
    );
    this.register(
      `${this.config.platform}-idempotency-recovery`,
      '0 */30 * * * *',
      () => this.handleIdempotencyRecovery(),
    );
    this.register(
      `${this.config.platform}-idempotency-cleanup`,
      '0 0 4 * * 0',
      () => this.handleIdempotencyCleanup(),
    );
    if (this.config.oauthStateRepo && this.config.lockIds.oauthState) {
      this.register(
        `${this.config.platform}-oauth-state-cleanup`,
        '0 */10 * * * *',
        () => this.handleOAuthStateCleanup(),
      );
    }
    if (this.config.reportClaimRepo && this.config.lockIds.reportClaim) {
      this.register(
        `${this.config.platform}-report-claims-cleanup`,
        '0 45 3 * * *',
        () => this.handleReportClaimsCleanup(),
      );
    }
  }

  onModuleDestroy(): void {
    for (const job of this.jobs.values()) {
      void job.stop();
    }
    this.jobs.clear();
  }

  async handleMessageLogCleanup(): Promise<void> {
    const { platform } = this.config;
    await this.cleanupService.execute(
      `${platform}-message-log-cleanup`,
      this.config.lockIds.messageLog,
      (cutoff) =>
        this.deleteBatched(
          'message_logs',
          `"platform" = $1 AND "created_at" < $2`,
          [platform, cutoff!],
        ),
    );
  }

  async handleDeadLetterCleanup(): Promise<void> {
    const { platform } = this.config;
    await this.cleanupService.execute(
      `${platform}-dead-letter-cleanup`,
      this.config.lockIds.deadLetter,
      (cutoff) =>
        this.deleteBatched(
          'webhook_dead_letters',
          `"platform" = $1 AND "status" IN ('replayed','abandoned') AND "created_at" < $2`,
          [platform, cutoff!],
        ),
    );
  }

  async handleIdempotencyRecovery(): Promise<void> {
    if (!this.config.rateLimitService.isEnabled()) return;
    const name = `${this.config.platform}-idempotency-recovery`;
    const result = await this.cleanupService.execute(
      name,
      this.config.lockIds.idempotencyRecovery,
      async () => {
        const { recovered } =
          await this.config.rateLimitService.recoverStuckReservedSlots();
        if (recovered.length > 0) {
          this.logger.log(
            `Recovered ${recovered.length} stuck idempotency keys`,
          );
        }
        return recovered.length;
      },
    );
    if (result !== null) this.config.metrics?.recordCronSuccess(name);
  }

  async handleIdempotencyCleanup(): Promise<void> {
    await this.cleanupService.execute(
      `${this.config.platform}-idempotency-cleanup`,
      this.config.lockIds.idempotencyCleanup,
      async (cutoff) => {
        const deleted = await this.deleteBatched(
          'chat_idempotency',
          `"platform" = $1 AND "status" IN ('completed','refunded') AND "reserved_at" < $2`,
          [this.config.platform, cutoff!],
        );
        const toolRetentionDays = this.parseRetentionDays(
          'CHAT_TOOL_DAILY_USAGE_RETENTION_DAYS',
          7,
        )();
        const toolCutoff = new Date();
        toolCutoff.setUTCDate(toolCutoff.getUTCDate() - toolRetentionDays);
        await this.deleteBatched(
          'chat_tool_daily_usage',
          `"platform" = $1 AND "usage_date" < $2::date`,
          [this.config.platform, toolCutoff.toISOString().slice(0, 10)],
        );
        return deleted;
      },
    );
  }

  async handleOAuthStateCleanup(): Promise<void> {
    await this.cleanupService.execute(
      `${this.config.platform}-oauth-state-cleanup`,
      this.config.lockIds.oauthState!,
      () => {
        const tenMinutesAgo = subMinutes(new Date(), 10);
        return this.config
          .oauthStateRepo!.delete({ createdAt: LessThan(tenMinutesAgo) })
          .then((r) => r.affected ?? 0);
      },
    );
  }

  /**
   * Both report-claim tables grow one row per learner/platform per day —
   * delete rows older than the retention window. Runs in all bots; the
   * advisory lock makes it a single effective execution per run.
   */
  async handleReportClaimsCleanup(): Promise<void> {
    await this.cleanupService.execute(
      `${this.config.platform}-report-claims-cleanup`,
      this.config.lockIds.reportClaim!,
      async (cutoff) => {
        const legacyDeleted = await this.deleteBatched(
          'scheduled_report_claims',
          `"created_at" < $1`,
          [cutoff!],
        );
        const learnerDeleted = await this.deleteBatched(
          'learner_scheduled_report_claims',
          `"created_at" < $1`,
          [cutoff!],
        );
        return legacyDeleted + learnerDeleted;
      },
    );
  }

  private register(
    name: string,
    cronTime: string,
    target: () => Promise<void>,
  ): void {
    const job = CronJob.from({
      cronTime,
      timeZone: CRON_TIMEZONE,
      onTick: () => {
        void target().catch((error) => this.logger.error(error));
      },
      start: true,
    });
    this.jobs.set(name, job);
  }

  private parseRetentionDays(
    configKey: string,
    fallback: number,
  ): () => number {
    return () => {
      return readEnvPositiveInt(this.configService, configKey, fallback);
    };
  }

  /**
   * Delete rows in bounded batches of 1 000 to avoid long-held locks.
   * `whereSql` uses positional parameters ($1, $2, ...) bound by `params`.
   */
  private async deleteBatched(
    table: string,
    whereSql: string,
    params: unknown[],
  ): Promise<number> {
    const BATCH_SIZE = 1000;
    let totalDeleted = 0;

    for (;;) {
      const ids: Array<{ id: number | string }> = await this.dataSource.query(
        `SELECT id FROM ${table} WHERE ${whereSql} LIMIT $${params.length + 1}`,
        [...params, BATCH_SIZE],
      );

      if (ids.length === 0) break;

      const result = await this.dataSource.query(
        `DELETE FROM ${table} WHERE id IN (${ids.map((_, i) => `$${i + 1}`).join(',')})`,
        ids.map((r) => r.id),
      );

      totalDeleted += result.rowCount ?? result.affected ?? 0;

      if (ids.length < BATCH_SIZE) {
        break;
      }
    }

    return totalDeleted;
  }
}
