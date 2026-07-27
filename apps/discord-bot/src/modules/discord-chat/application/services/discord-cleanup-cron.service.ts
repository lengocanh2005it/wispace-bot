import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { ConfigService } from '@nestjs/config';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, LessThan } from 'typeorm';
import { DiscordMessageLogEntity } from '../../../../infrastructure/database/entities/discord-message-log.entity';
import { WebhookDeadLetterEntity } from '../../../../infrastructure/database/entities/webhook-dead-letter.entity';

const MESSAGE_LOG_LOCK_ID = 884_200_911;
const DEAD_LETTER_LOCK_ID = 884_200_912;

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
}
