import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  CleanupCronService,
  type CleanupCronConfig,
} from '@wispace/cleanup-cron';
import { MESSENGER_REPOSITORY } from '../../domain/repositories/messenger.repository.port';
import type { MessengerRepositoryPort } from '../../domain/repositories/messenger.repository.port';

const DEFAULT_RETENTION_DAYS = 90;

const CLEANUP_CONFIG: CleanupCronConfig = {
  name: 'messenger-message-log-cleanup',
  advisoryLockId: 100,
  cronExpression: '0 0 3 * * 1',
  timeZone: 'Asia/Ho_Chi_Minh',
  enabledConfigKey: 'MESSENGER_MESSAGE_LOG_CLEANUP_ENABLED',
  retentionDaysConfigKey: 'MESSENGER_MESSAGE_LOG_RETENTION_DAYS',
  defaultRetentionDays: DEFAULT_RETENTION_DAYS,
};

@Injectable()
export class MessengerMessageLogCleanupService {
  private readonly logger = new Logger(MessengerMessageLogCleanupService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(MESSENGER_REPOSITORY)
    private readonly messengerRepository: MessengerRepositoryPort,
    private readonly cleanupCron: CleanupCronService,
  ) {}

  isEnabled(): boolean {
    const raw = this.configService
      .get<string>(CLEANUP_CONFIG.enabledConfigKey)
      ?.trim()
      .toLowerCase();

    if (!raw) {
      return true;
    }

    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  getRetentionDays(): number {
    const raw = this.configService
      .get<string>(CLEANUP_CONFIG.retentionDaysConfigKey)
      ?.trim();

    if (!raw) {
      return CLEANUP_CONFIG.defaultRetentionDays;
    }

    const value = Number(raw);
    if (!Number.isFinite(value) || value <= 0) {
      return CLEANUP_CONFIG.defaultRetentionDays;
    }

    return Math.floor(value);
  }

  async purgeExpiredLogs(): Promise<{ deleted: number; cutoff: string }> {
    const retentionDays = this.getRetentionDays();
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);

    const deleted =
      await this.messengerRepository.deleteMessageLogsOlderThan(cutoff);

    if (deleted > 0) {
      this.logger.log(
        `Purged ${deleted} message_logs row(s) older than ${retentionDays} day(s) (before ${cutoff.toISOString()})`,
      );
    } else {
      this.logger.log(
        `message_logs cleanup: 0 rows older than ${retentionDays} day(s)`,
      );
    }

    return { deleted, cutoff: cutoff.toISOString() };
  }

  /** Purge old audit rows — 03:00 ICT every Monday. */
  @Cron(CLEANUP_CONFIG.cronExpression, {
    name: CLEANUP_CONFIG.name,
    timeZone: CLEANUP_CONFIG.timeZone,
  })
  async handleWeeklyCleanup(): Promise<void> {
    await this.cleanupCron.execute(
      CLEANUP_CONFIG,
      (cutoff) => this.messengerRepository.deleteMessageLogsOlderThan(cutoff),
      () => this.isEnabled(),
      () => this.getRetentionDays(),
    );
  }
}
