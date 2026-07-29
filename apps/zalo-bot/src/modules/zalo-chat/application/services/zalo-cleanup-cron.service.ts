import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { ChatIdempotencyEntity } from '@wispace/chat-metering';
import { ZaloOauthStateEntity } from '@zalo/infrastructure/database/entities/zalo-oauth-state.entity';
import { ZaloMessageLogEntity } from '@zalo/infrastructure/database/entities/zalo-message-log.entity';
import { WebhookDeadLetterEntity } from '@zalo/infrastructure/database/entities/webhook-dead-letter.entity';
import { ZaloChatRateLimitService } from './zalo-chat-rate-limit.service';

const OAUTH_STATE_LOCK_ID = 884_200_913;
const MESSAGE_LOG_LOCK_ID = 884_200_916;
const DEAD_LETTER_LOCK_ID = 884_200_917;
const IDEMPOTENCY_RECOVERY_LOCK_ID = 884_200_918;
const IDEMPOTENCY_CLEANUP_LOCK_ID = 884_200_919;

@Injectable()
export class ZaloCleanupCronService {
  private readonly logger = new Logger(ZaloCleanupCronService.name);

  constructor(
    private readonly cleanupService: CleanupCronService,
    private readonly configService: ConfigService,
    @InjectRepository(ZaloOauthStateEntity)
    private readonly oauthStateRepo: Repository<ZaloOauthStateEntity>,
    @InjectRepository(ZaloMessageLogEntity)
    private readonly messageLogRepo: Repository<ZaloMessageLogEntity>,
    @InjectRepository(WebhookDeadLetterEntity)
    private readonly deadLetterRepo: Repository<WebhookDeadLetterEntity>,
    @InjectRepository(ChatIdempotencyEntity)
    private readonly idempotencyRepo: Repository<ChatIdempotencyEntity>,
    private readonly rateLimitService: ZaloChatRateLimitService,
  ) {}

  @Cron('0 */10 * * * *', {
    name: 'zalo-oauth-state-cleanup',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleOAuthStateCleanup(): Promise<void> {
    await this.cleanupService.execute(
      {
        name: 'zalo-oauth-state-cleanup',
        advisoryLockId: OAUTH_STATE_LOCK_ID,
        cronExpression: '0 */10 * * * *',
        enabledConfigKey: 'ZALO_OAUTH_STATE_CLEANUP_ENABLED',
        retentionDaysConfigKey: 'ZALO_OAUTH_STATE_RETENTION_DAYS',
        defaultRetentionDays: 0,
      },
      () => {
        const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000);
        return this.oauthStateRepo
          .delete({ createdAt: LessThan(tenMinutesAgo) })
          .then((r) => r.affected ?? 0);
      },
      () => true,
      () => 0,
    );
  }

  @Cron('0 0 3 * * *', {
    name: 'zalo-message-log-cleanup',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleMessageLogCleanup(): Promise<void> {
    const isEnabled = () => {
      const raw = this.configService
        .get<string>('ZALO_MESSAGE_LOG_CLEANUP_ENABLED')
        ?.trim()
        .toLowerCase();
      return raw !== 'false' && raw !== '0';
    };

    const getRetentionDays = () => {
      const raw = this.configService
        .get<string>('ZALO_MESSAGE_LOG_RETENTION_DAYS')
        ?.trim();
      if (!raw) return 90;
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? value : 90;
    };

    await this.cleanupService.execute(
      {
        name: 'zalo-message-log-cleanup',
        advisoryLockId: MESSAGE_LOG_LOCK_ID,
        cronExpression: '0 0 3 * * *',
        enabledConfigKey: 'ZALO_MESSAGE_LOG_CLEANUP_ENABLED',
        retentionDaysConfigKey: 'ZALO_MESSAGE_LOG_RETENTION_DAYS',
        defaultRetentionDays: 90,
      },
      (cutoff) =>
        this.messageLogRepo
          .delete({ createdAt: LessThan(cutoff) })
          .then((r) => r.affected ?? 0),
      isEnabled,
      getRetentionDays,
    );
  }

  @Cron('0 30 3 * * *', {
    name: 'zalo-dead-letter-cleanup',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleDeadLetterCleanup(): Promise<void> {
    const isEnabled = () => {
      const raw = this.configService
        .get<string>('ZALO_DEAD_LETTER_CLEANUP_ENABLED')
        ?.trim()
        .toLowerCase();
      return raw !== 'false' && raw !== '0';
    };

    const getRetentionDays = () => {
      const raw = this.configService
        .get<string>('ZALO_DEAD_LETTER_RETENTION_DAYS')
        ?.trim();
      if (!raw) return 30;
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? value : 30;
    };

    await this.cleanupService.execute(
      {
        name: 'zalo-dead-letter-cleanup',
        advisoryLockId: DEAD_LETTER_LOCK_ID,
        cronExpression: '0 30 3 * * *',
        enabledConfigKey: 'ZALO_DEAD_LETTER_CLEANUP_ENABLED',
        retentionDaysConfigKey: 'ZALO_DEAD_LETTER_RETENTION_DAYS',
        defaultRetentionDays: 30,
      },
      (cutoff) =>
        this.deadLetterRepo
          .delete({
            status: ['replayed', 'abandoned'] as never,
            createdAt: LessThan(cutoff),
          })
          .then((r) => r.affected ?? 0),
      isEnabled,
      getRetentionDays,
    );
  }

  @Cron('0 */30 * * * *', {
    name: 'zalo-idempotency-recovery',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleIdempotencyRecovery(): Promise<void> {
    if (!this.rateLimitService.isEnabled()) return;
    await this.cleanupService.execute(
      {
        name: 'zalo-idempotency-recovery',
        advisoryLockId: IDEMPOTENCY_RECOVERY_LOCK_ID,
        cronExpression: '0 */30 * * * *',
        enabledConfigKey: '',
        retentionDaysConfigKey: '',
        defaultRetentionDays: 0,
      },
      async () => {
        const { recovered } =
          await this.rateLimitService.recoverStuckReservedSlots();
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

  @Cron('0 0 4 * * 0', {
    name: 'zalo-idempotency-cleanup',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleIdempotencyCleanup(): Promise<void> {
    const retentionDays = (() => {
      const raw = this.configService
        .get<string>('CHAT_IDEMPOTENCY_RETENTION_DAYS')
        ?.trim();
      if (!raw) return 90;
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? value : 90;
    })();

    await this.cleanupService.execute(
      {
        name: 'zalo-idempotency-cleanup',
        advisoryLockId: IDEMPOTENCY_CLEANUP_LOCK_ID,
        cronExpression: '0 0 4 * * 0',
        enabledConfigKey: '',
        retentionDaysConfigKey: '',
        defaultRetentionDays: retentionDays,
      },
      (cutoff) =>
        this.idempotencyRepo
          .createQueryBuilder()
          .delete()
          .from(ChatIdempotencyEntity)
          .where('platform = :platform', { platform: 'zalo' })
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
}
