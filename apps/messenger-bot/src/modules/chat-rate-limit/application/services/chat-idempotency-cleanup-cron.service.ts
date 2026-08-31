import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  CleanupCronService,
  type CleanupCronConfig,
} from '@wispace/cleanup-cron';
import {
  ChatIdempotencyEntity,
  ChatToolDailyUsageEntity,
} from '@wispace/chat-metering';

const CLEANUP_CONFIG: CleanupCronConfig = {
  name: 'chat-idempotency-cleanup',
  advisoryLockId: 202,
  cronExpression: '0 30 3 * * *',
  timeZone: 'Asia/Ho_Chi_Minh',
  enabledConfigKey: 'CHAT_IDEMPOTENCY_CLEANUP_ENABLED',
  retentionDaysConfigKey: 'CHAT_IDEMPOTENCY_RETENTION_DAYS',
  defaultRetentionDays: 90,
};

/**
 * Purges terminal `chat_idempotency` rows (completed/refunded) older than
 * CHAT_IDEMPOTENCY_RETENTION_DAYS. Without this the idempotency PK
 * (platform, idempotency_key) accumulates forever — and the ops script is the
 * only other purge path.
 */
@Injectable()
export class ChatIdempotencyCleanupCronService {
  private readonly logger = new Logger(ChatIdempotencyCleanupCronService.name);

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(ChatIdempotencyEntity)
    private readonly idempotencyRepo: Repository<ChatIdempotencyEntity>,
    @InjectRepository(ChatToolDailyUsageEntity)
    private readonly toolDailyUsageRepo: Repository<ChatToolDailyUsageEntity>,
    private readonly cleanupCron: CleanupCronService,
  ) {}

  /** Purge old terminal idempotency rows — 03:30 ICT daily. */
  @Cron(CLEANUP_CONFIG.cronExpression, {
    name: CLEANUP_CONFIG.name,
    timeZone: CLEANUP_CONFIG.timeZone,
  })
  async handleDailyCleanup(): Promise<void> {
    await this.cleanupCron.execute(
      CLEANUP_CONFIG,
      (cutoff) => this.deleteBatched(cutoff),
      () => this.isEnabled(),
      () => this.getRetentionDays(),
    );
  }

  private async deleteBatched(cutoff: Date): Promise<number> {
    const BATCH_SIZE = 1000;
    let totalDeleted = 0;

    for (;;) {
      const ids: Array<{ id: number }> = await this.idempotencyRepo.query(
        `SELECT id FROM chat_idempotency
         WHERE "platform" = 'messenger'
           AND "status" IN ('completed','refunded')
           AND "reserved_at" < $1
         LIMIT $2`,
        [cutoff, BATCH_SIZE],
      );

      if (ids.length === 0) break;

      const result = await this.idempotencyRepo
        .createQueryBuilder()
        .delete()
        .from(ChatIdempotencyEntity)
        .where('id IN (:...ids)', { ids: ids.map((r) => r.id) })
        .execute();

      totalDeleted += result.affected ?? 0;

      if (ids.length < BATCH_SIZE) {
        break;
      }
    }

    // #626: prune aged write-tool budget counters (self-bounded by the date key,
    // kept ~7 days so ops can inspect "who hit caps"). A non-positive / invalid
    // override falls back to the default — never delete same-day counters.
    const rawToolRetention = Number(
      this.configService.get<string>('CHAT_TOOL_DAILY_USAGE_RETENTION_DAYS'),
    );
    const toolRetentionDays =
      Number.isFinite(rawToolRetention) && rawToolRetention > 0
        ? Math.floor(rawToolRetention)
        : 7;
    const toolCutoff = new Date();
    toolCutoff.setUTCDate(toolCutoff.getUTCDate() - toolRetentionDays);
    await this.toolDailyUsageRepo.manager.query(
      `DELETE FROM chat_tool_daily_usage WHERE platform = 'messenger' AND usage_date < $1::date`,
      [toolCutoff.toISOString().slice(0, 10)],
    );

    return totalDeleted;
  }

  private isEnabled(): boolean {
    const raw = this.configService
      .get<string>(CLEANUP_CONFIG.enabledConfigKey)
      ?.trim()
      .toLowerCase();

    if (!raw) {
      // Default on: only reserved rows are protected from deletion anyway.
      return true;
    }

    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  private getRetentionDays(): number {
    const raw = this.configService.get<string>(
      CLEANUP_CONFIG.retentionDaysConfigKey,
    );
    const parsed = raw ? Number(raw) : NaN;
    return Number.isFinite(parsed) && parsed > 0
      ? Math.floor(parsed)
      : CLEANUP_CONFIG.defaultRetentionDays;
  }
}
