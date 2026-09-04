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
import { ChatIdempotencyEntity } from '@wispace/chat-metering';
import { WebhookDeadLetterEntity } from '@wispace/database';
import type { Platform } from '@wispace/contracts';
import { subMinutes } from 'date-fns';
import { CleanupCronService } from './cleanup-cron.service';

export interface CleanupCronJobsConfig {
  /** Platform name ('discord' | 'zalo') — used for cron names and idempotency cleanup filter. */
  platform: Platform;
  /** Env var prefix for cleanup toggles/retention (e.g. 'DISCORD_'). */
  envPrefix: string;
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
}

const CRON_TIMEZONE = 'Asia/Ho_Chi_Minh';

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
    const { envPrefix, platform } = this.config;
    await this.cleanupService.execute(
      {
        name: `${platform}-message-log-cleanup`,
        advisoryLockId: this.config.lockIds.messageLog,
        cronExpression: '0 0 3 * * *',
        enabledConfigKey: `${envPrefix}MESSAGE_LOG_CLEANUP_ENABLED`,
        retentionDaysConfigKey: `${envPrefix}MESSAGE_LOG_RETENTION_DAYS`,
        defaultRetentionDays: 90,
      },
      (cutoff) =>
        this.deleteBatched(
          'message_logs',
          `"platform" = $1 AND "created_at" < $2`,
          [platform, cutoff],
        ),
      this.parseEnabled(`${envPrefix}MESSAGE_LOG_CLEANUP_ENABLED`),
      this.parseRetentionDays(`${envPrefix}MESSAGE_LOG_RETENTION_DAYS`, 90),
    );
  }

  async handleDeadLetterCleanup(): Promise<void> {
    const { envPrefix, platform } = this.config;
    await this.cleanupService.execute(
      {
        name: `${platform}-dead-letter-cleanup`,
        advisoryLockId: this.config.lockIds.deadLetter,
        cronExpression: '0 30 3 * * *',
        enabledConfigKey: `${envPrefix}DEAD_LETTER_CLEANUP_ENABLED`,
        retentionDaysConfigKey: `${envPrefix}DEAD_LETTER_RETENTION_DAYS`,
        defaultRetentionDays: 30,
      },
      (cutoff) =>
        this.deleteBatched(
          'webhook_dead_letters',
          `"platform" = $1 AND "status" IN ('replayed','abandoned') AND "created_at" < $2`,
          [platform, cutoff],
        ),
      this.parseEnabled(`${envPrefix}DEAD_LETTER_CLEANUP_ENABLED`),
      this.parseRetentionDays(`${envPrefix}DEAD_LETTER_RETENTION_DAYS`, 30),
    );
  }

  async handleIdempotencyRecovery(): Promise<void> {
    if (!this.config.rateLimitService.isEnabled()) return;
    await this.cleanupService.execute(
      {
        name: `${this.config.platform}-idempotency-recovery`,
        advisoryLockId: this.config.lockIds.idempotencyRecovery,
        cronExpression: '0 */30 * * * *',
        enabledConfigKey: '',
        retentionDaysConfigKey: '',
        defaultRetentionDays: 0,
      },
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
      () => true,
      () => 0,
    );
  }

  async handleIdempotencyCleanup(): Promise<void> {
    const retentionDays = this.parseRetentionDays(
      'CHAT_IDEMPOTENCY_RETENTION_DAYS',
      90,
    )();
    await this.cleanupService.execute(
      {
        name: `${this.config.platform}-idempotency-cleanup`,
        advisoryLockId: this.config.lockIds.idempotencyCleanup,
        cronExpression: '0 0 4 * * 0',
        enabledConfigKey: '',
        retentionDaysConfigKey: '',
        defaultRetentionDays: retentionDays,
      },
      async (cutoff) => {
        const deleted = await this.deleteBatched(
          'chat_idempotency',
          `"platform" = $1 AND "status" IN ('completed','refunded') AND "reserved_at" < $2`,
          [this.config.platform, cutoff],
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
      () => true,
      () => retentionDays,
    );
  }

  async handleOAuthStateCleanup(): Promise<void> {
    const { envPrefix } = this.config;
    await this.cleanupService.execute(
      {
        name: `${this.config.platform}-oauth-state-cleanup`,
        advisoryLockId: this.config.lockIds.oauthState!,
        cronExpression: '0 */10 * * * *',
        enabledConfigKey: `${envPrefix}OAUTH_STATE_CLEANUP_ENABLED`,
        retentionDaysConfigKey: `${envPrefix}OAUTH_STATE_RETENTION_DAYS`,
        defaultRetentionDays: 0,
      },
      () => {
        const tenMinutesAgo = subMinutes(new Date(), 10);
        return this.config
          .oauthStateRepo!.delete({ createdAt: LessThan(tenMinutesAgo) })
          .then((r) => r.affected ?? 0);
      },
      () => true,
      () => 0,
    );
  }

  /**
   * Both report-claim tables grow one row per learner/platform per day —
   * delete rows older than the retention window. Runs in all bots; the
   * advisory lock makes it a single effective execution per run.
   */
  async handleReportClaimsCleanup(): Promise<void> {
    const { envPrefix } = this.config;
    const retentionDays = this.parseRetentionDays(
      `${envPrefix}REPORT_CLAIMS_RETENTION_DAYS`,
      90,
    )();
    await this.cleanupService.execute(
      {
        name: `${this.config.platform}-report-claims-cleanup`,
        advisoryLockId: this.config.lockIds.reportClaim!,
        cronExpression: '0 45 3 * * *',
        enabledConfigKey: `${envPrefix}REPORT_CLAIMS_CLEANUP_ENABLED`,
        retentionDaysConfigKey: `${envPrefix}REPORT_CLAIMS_RETENTION_DAYS`,
        defaultRetentionDays: 90,
      },
      async (cutoff) => {
        const legacyDeleted = await this.deleteBatched(
          'scheduled_report_claims',
          `"created_at" < $1`,
          [cutoff],
        );
        const learnerDeleted = await this.deleteBatched(
          'learner_scheduled_report_claims',
          `"created_at" < $1`,
          [cutoff],
        );
        return legacyDeleted + learnerDeleted;
      },
      this.parseEnabled(`${envPrefix}REPORT_CLAIMS_CLEANUP_ENABLED`),
      () => retentionDays,
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

  private parseEnabled(configKey: string): () => boolean {
    return () => {
      const raw = this.configService
        .get<string>(configKey)
        ?.trim()
        .toLowerCase();
      return raw !== 'false' && raw !== '0';
    };
  }

  private parseRetentionDays(
    configKey: string,
    fallback: number,
  ): () => number {
    return () => {
      const raw = this.configService.get<string>(configKey)?.trim();
      if (!raw) return fallback;
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? value : fallback;
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
