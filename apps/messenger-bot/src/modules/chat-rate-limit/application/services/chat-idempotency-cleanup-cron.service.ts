import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, Repository } from 'typeorm';
import {
  CleanupCronService,
  type CleanupCronConfig,
} from '@wispace/cleanup-cron';
import { ChatIdempotencyEntity } from '@wispace/chat-metering';

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
      (cutoff) =>
        this.idempotencyRepo
          .delete({
            status: ['completed', 'refunded'] as never,
            reservedAt: LessThan(cutoff),
          })
          .then((r) => r.affected ?? 0),
      () => this.isEnabled(),
      () => this.getRetentionDays(),
    );
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
