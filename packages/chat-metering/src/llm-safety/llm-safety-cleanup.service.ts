import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { PlatformLlmSafetyEventAdapter } from './platform-llm-safety-event.adapter';

/**
 * Hourly cleanup of LLM safety events older than the retention period.
 * Shared by Discord and Zalo — registers as a NestJS provider with @Cron.
 */
@Injectable()
export class LlmSafetyCleanupService {
  private readonly logger = new Logger(LlmSafetyCleanupService.name);

  constructor(
    private readonly adapter: PlatformLlmSafetyEventAdapter,
  ) {}

  @Cron('0 3 * * *', {
    name: 'llm-safety-cleanup',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async runCleanup(): Promise<void> {
    const deleted = await this.adapter.deleteOlderThanRetention();
    if (deleted > 0) {
      this.logger.log(
        `LLM_SAFETY_CLEANUP deleted=${deleted} platform=${this.adapter['platform']}`,
      );
    }
  }
}
