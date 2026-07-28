import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  CleanupCronService,
  type CleanupCronConfig,
} from '@wispace/cleanup-cron';
import { CHAT_QUOTA_EVENT_REPOSITORY } from '../../domain/repositories/chat-quota-event.repository.port';
import type { ChatQuotaEventRepositoryPort } from '../../domain/repositories/chat-quota-event.repository.port';
import { ChatRateLimitConfigService } from './chat-rate-limit-config.service';

const CLEANUP_CONFIG: CleanupCronConfig = {
  name: 'chat-quota-events-cleanup',
  advisoryLockId: 200,
  cronExpression: '0 30 3 1 * *',
  timeZone: 'Asia/Ho_Chi_Minh',
  enabledConfigKey: 'CHAT_QUOTA_EVENTS_CLEANUP_ENABLED',
  retentionDaysConfigKey: 'CHAT_QUOTA_EVENTS_RETENTION_DAYS',
  defaultRetentionDays: 90,
};

@Injectable()
export class ChatQuotaEventCleanupCronService {
  private readonly logger = new Logger(ChatQuotaEventCleanupCronService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly chatConfig: ChatRateLimitConfigService,
    @Inject(CHAT_QUOTA_EVENT_REPOSITORY)
    private readonly eventRepository: ChatQuotaEventRepositoryPort,
    private readonly cleanupCron: CleanupCronService,
  ) {}

  isEnabled(): boolean {
    const raw = this.configService
      .get<string>(CLEANUP_CONFIG.enabledConfigKey)
      ?.trim()
      .toLowerCase();

    if (!raw) {
      return this.chatConfig.isQuotaEventsEnabled();
    }

    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  getRetentionDays(): number {
    return this.chatConfig.getQuotaEventsRetentionDays();
  }

  /** Purge old quota audit events — 03:30 ICT on the 1st of each month. */
  @Cron(CLEANUP_CONFIG.cronExpression, {
    name: CLEANUP_CONFIG.name,
    timeZone: CLEANUP_CONFIG.timeZone,
  })
  async handleMonthlyCleanup(): Promise<void> {
    await this.cleanupCron.execute(
      CLEANUP_CONFIG,
      (cutoff) => this.eventRepository.deleteOlderThan(cutoff),
      () => this.isEnabled(),
      () => this.getRetentionDays(),
    );
  }
}
