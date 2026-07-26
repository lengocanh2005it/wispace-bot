import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { LlmSafetyEventService } from './llm-safety-event.service';
import { PgAdvisoryLockService } from '../../../../shared/common/pg-advisory-lock.service';
import { ADVISORY_LOCK } from '../../../../shared/common/advisory-lock-ids';

@Injectable()
export class LlmSafetyCleanupService {
  private readonly logger = new Logger(LlmSafetyCleanupService.name);

  constructor(
    private readonly llmSafetyEventService: LlmSafetyEventService,
    private readonly pgLock: PgAdvisoryLockService,
  ) {}

  @Cron('0 3 * * *', {
    name: 'llm-safety-cleanup',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async runCleanup(): Promise<void> {
    if (!this.llmSafetyEventService.isEnabled()) return;

    await this.pgLock.withLock(ADVISORY_LOCK.LLM_SAFETY_CLEANUP, async () => {
      try {
        await this.llmSafetyEventService.deleteOlderThanRetentionDays();
      } catch (err) {
        this.logger.warn(
          `llm-safety-cleanup failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    });
  }
}
