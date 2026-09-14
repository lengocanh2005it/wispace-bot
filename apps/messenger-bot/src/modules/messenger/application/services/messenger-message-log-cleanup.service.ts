import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CleanupCronService } from '@wispace/cleanup-cron';
import { MESSENGER_MESSAGE_LOG_REPOSITORY } from '../../domain/repositories/messenger-message-log.repository.port';
import type { MessengerMessageLogRepositoryPort } from '../../domain/repositories/messenger-message-log.repository.port';
import { subDays } from 'date-fns';

const CLEANUP_NAME = 'messenger-message-log-cleanup';
const CLEANUP_LOCK_ID = 100;
const CLEANUP_CRON = '0 0 3 * * 1';

@Injectable()
export class MessengerMessageLogCleanupService {
  private readonly logger = new Logger(MessengerMessageLogCleanupService.name);

  constructor(
    @Inject(MESSENGER_MESSAGE_LOG_REPOSITORY)
    private readonly messengerRepository: MessengerMessageLogRepositoryPort,
    private readonly cleanupCron: CleanupCronService,
  ) {}

  isEnabled(): boolean {
    return this.cleanupCron.isEnabled(CLEANUP_NAME);
  }

  getRetentionDays(): number {
    return this.cleanupCron.getRetentionDays(CLEANUP_NAME);
  }

  async purgeExpiredLogs(): Promise<{ deleted: number; cutoff: string }> {
    const retentionDays = this.getRetentionDays();
    const cutoff = subDays(new Date(), retentionDays);

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
  @Cron(CLEANUP_CRON, {
    name: CLEANUP_NAME,
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleWeeklyCleanup(): Promise<void> {
    await this.cleanupCron.execute(CLEANUP_NAME, CLEANUP_LOCK_ID, (cutoff) =>
      this.messengerRepository.deleteMessageLogsOlderThan(cutoff!),
    );
  }
}
