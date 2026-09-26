import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CleanupCronService } from '@wispace/cleanup-cron/adapters';
import { CHAT_QUOTA_EVENT_REPOSITORY } from '../../domain/repositories/chat-quota-event.repository.port';
import type { ChatQuotaEventRepositoryPort } from '../../domain/repositories/chat-quota-event.repository.port';

const CLEANUP_NAME = 'chat-quota-events-cleanup';
const CLEANUP_LOCK_ID = 200;
const CLEANUP_CRON = '0 30 3 1 * *';

@Injectable()
export class ChatQuotaEventCleanupCronService {
  constructor(
    @Inject(CHAT_QUOTA_EVENT_REPOSITORY)
    private readonly eventRepository: ChatQuotaEventRepositoryPort,
    private readonly cleanupCron: CleanupCronService,
  ) {}

  /** Purge old quota audit events — 03:30 ICT on the 1st of each month. */
  @Cron(CLEANUP_CRON, {
    name: CLEANUP_NAME,
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleMonthlyCleanup(): Promise<void> {
    await this.cleanupCron.execute(CLEANUP_NAME, CLEANUP_LOCK_ID, (cutoff) =>
      this.eventRepository.deleteOlderThan(cutoff!),
    );
  }
}
