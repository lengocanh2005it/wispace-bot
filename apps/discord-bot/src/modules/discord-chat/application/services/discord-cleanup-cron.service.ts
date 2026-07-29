import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { ChatIdempotencyEntity } from '@wispace/chat-metering';
import { DiscordMessageLogEntity } from '@discord/infrastructure/database/entities/discord-message-log.entity';
import { WebhookDeadLetterEntity } from '@discord/infrastructure/database/entities/webhook-dead-letter.entity';
import { DiscordChatRateLimitService } from '@discord/modules/chat-metering/application/services/discord-chat-rate-limit.service';

const MESSAGE_LOG_LOCK_ID = 884_200_911;
const DEAD_LETTER_LOCK_ID = 884_200_912;
const IDEMPOTENCY_RECOVERY_LOCK_ID = 884_200_914;
const IDEMPOTENCY_CLEANUP_LOCK_ID = 884_200_915;

@Injectable()
export class DiscordCleanupCronService {
  private readonly logger = new Logger(DiscordCleanupCronService.name);

  constructor(
    private readonly cleanupService: CleanupCronService,
    private readonly configService: ConfigService,
    @InjectRepository(DiscordMessageLogEntity)
    private readonly messageLogRepo: Repository<DiscordMessageLogEntity>,
    @InjectRepository(WebhookDeadLetterEntity)
    private readonly deadLetterRepo: Repository<WebhookDeadLetterEntity>,
    @InjectRepository(ChatIdempotencyEntity)
    private readonly idempotencyRepo: Repository<ChatIdempotencyEntity>,
    private readonly rateLimitService: DiscordChatRateLimitService,
  ) {}

  @Cron('0 0 3 * * *', {
    name: 'discord-message-log-cleanup',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleMessageLogCleanup(): Promise<void> {
    const isEnabled = () => {
      const raw = this.configService
        .get<string>('DISCORD_MESSAGE_LOG_CLEANUP_ENABLED')
        ?.trim()
        .toLowerCase();
      return raw !== 'false' && raw !== '0';
    };

    const getRetentionDays = () => {
      const raw = this.configService
        .get<string>('DISCORD_MESSAGE_LOG_RETENTION_DAYS')
        ?.trim();
      if (!raw) return 90;
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? value : 90;
    };

    await this.cleanupService.execute(
      {
        name: 'discord-message-log-cleanup',
        advisoryLockId: MESSAGE_LOG_LOCK_ID,
        cronExpression: '0 0 3 * * *',
        enabledConfigKey: 'DISCORD_MESSAGE_LOG_CLEANUP_ENABLED',
        retentionDaysConfigKey: 'DISCORD_MESSAGE_LOG_RETENTION_DAYS',
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
    name: 'discord-dead-letter-cleanup',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleDeadLetterCleanup(): Promise<void> {
    const isEnabled = () => {
      const raw = this.configService
        .get<string>('DISCORD_DEAD_LETTER_CLEANUP_ENABLED')
        ?.trim()
        .toLowerCase();
      return raw !== 'false' && raw !== '0';
    };

    const getRetentionDays = () => {
      const raw = this.configService
        .get<string>('DISCORD_DEAD_LETTER_RETENTION_DAYS')
        ?.trim();
      if (!raw) return 30;
      const value = Number(raw);
      return Number.isFinite(value) && value > 0 ? value : 30;
    };

    await this.cleanupService.execute(
      {
        name: 'discord-dead-letter-cleanup',
        advisoryLockId: DEAD_LETTER_LOCK_ID,
        cronExpression: '0 30 3 * * *',
        enabledConfigKey: 'DISCORD_DEAD_LETTER_CLEANUP_ENABLED',
        retentionDaysConfigKey: 'DISCORD_DEAD_LETTER_RETENTION_DAYS',
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
    name: 'discord-idempotency-recovery',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleIdempotencyRecovery(): Promise<void> {
    if (!this.rateLimitService.isEnabled()) return;
    await this.cleanupService.execute(
      {
        name: 'discord-idempotency-recovery',
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
    name: 'discord-idempotency-cleanup',
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
        name: 'discord-idempotency-cleanup',
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
          .where('platform = :platform', { platform: 'discord' })
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
