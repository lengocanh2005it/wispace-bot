import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CronJob } from 'cron';
import { LessThan, Repository } from 'typeorm';
import { ChatIdempotencyEntity } from '@wispace/chat-metering';
import { WebhookDeadLetterEntity } from '@wispace/database';
import type { Platform } from '@wispace/database';
import { minutesAgo } from '@wispace/date-utils';
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
    /** Zalo-only 5th cron (oauth state cleanup). */
    oauthState?: number;
  };
  messageLogRepo: Repository<{ createdAt: Date }>;
  deadLetterRepo: Repository<WebhookDeadLetterEntity>;
  idempotencyRepo: Repository<ChatIdempotencyEntity>;
  /** Zalo-only oauth state cleanup repo. */
  oauthStateRepo?: Repository<{ createdAt: Date }>;
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
  }

  onModuleDestroy(): void {
    for (const job of this.jobs.values()) {
      void job.stop();
    }
    this.jobs.clear();
  }

  async handleMessageLogCleanup(): Promise<void> {
    const { envPrefix } = this.config;
    await this.cleanupService.execute(
      {
        name: `${this.config.platform}-message-log-cleanup`,
        advisoryLockId: this.config.lockIds.messageLog,
        cronExpression: '0 0 3 * * *',
        enabledConfigKey: `${envPrefix}MESSAGE_LOG_CLEANUP_ENABLED`,
        retentionDaysConfigKey: `${envPrefix}MESSAGE_LOG_RETENTION_DAYS`,
        defaultRetentionDays: 90,
      },
      (cutoff) =>
        this.config.messageLogRepo
          .delete({ createdAt: LessThan(cutoff) })
          .then((r) => r.affected ?? 0),
      this.parseEnabled(`${envPrefix}MESSAGE_LOG_CLEANUP_ENABLED`),
      this.parseRetentionDays(`${envPrefix}MESSAGE_LOG_RETENTION_DAYS`, 90),
    );
  }

  async handleDeadLetterCleanup(): Promise<void> {
    const { envPrefix } = this.config;
    await this.cleanupService.execute(
      {
        name: `${this.config.platform}-dead-letter-cleanup`,
        advisoryLockId: this.config.lockIds.deadLetter,
        cronExpression: '0 30 3 * * *',
        enabledConfigKey: `${envPrefix}DEAD_LETTER_CLEANUP_ENABLED`,
        retentionDaysConfigKey: `${envPrefix}DEAD_LETTER_RETENTION_DAYS`,
        defaultRetentionDays: 30,
      },
      (cutoff) =>
        this.config.deadLetterRepo
          .delete({
            status: ['replayed', 'abandoned'] as never,
            createdAt: LessThan(cutoff),
          })
          .then((r) => r.affected ?? 0),
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
      (cutoff) =>
        this.config.idempotencyRepo
          .createQueryBuilder()
          .delete()
          .from(ChatIdempotencyEntity)
          .where('platform = :platform', { platform: this.config.platform })
          .andWhere('status IN (:...statuses)', {
            statuses: ['completed', 'refunded'],
          })
          .andWhere('reserved_at < :cutoff', { cutoff })
          .execute()
          .then((r) => r.affected ?? 0),
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
        const tenMinutesAgo = minutesAgo(10);
        return this.config
          .oauthStateRepo!.delete({ createdAt: LessThan(tenMinutesAgo) })
          .then((r) => r.affected ?? 0);
      },
      () => true,
      () => 0,
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
}
