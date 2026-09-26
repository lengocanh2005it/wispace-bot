import { Inject, Injectable } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { CleanupCronService } from '@wispace/cleanup-cron/adapters';
import {
  LLM_USAGE_REPOSITORY,
  type LlmUsageRepositoryPort,
} from '../../domain/repositories/llm-usage.repository.port';

const CLEANUP_NAME = 'llm-usage-cleanup';
const CLEANUP_LOCK_ID = 300;
const CLEANUP_CRON = '0 0 4 1 * *';

@Injectable()
export class LlmUsageCleanupCronService {
  constructor(
    @Inject(LLM_USAGE_REPOSITORY)
    private readonly usageRepository: LlmUsageRepositoryPort,
    private readonly cleanupCron: CleanupCronService,
  ) {}

  /** Purge old LLM usage rows — 04:00 ICT on the 1st of each month. */
  @Cron(CLEANUP_CRON, {
    name: CLEANUP_NAME,
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async handleMonthlyCleanup(): Promise<void> {
    await this.cleanupCron.execute(CLEANUP_NAME, CLEANUP_LOCK_ID, (cutoff) =>
      this.usageRepository.deleteOlderThan(cutoff!),
    );
  }
}
