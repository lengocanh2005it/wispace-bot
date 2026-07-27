import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import {
  CleanupCronService,
  type CleanupCronConfig,
} from '@wispace/cleanup-cron';
import {
  LLM_USAGE_REPOSITORY,
  type LlmUsageRepositoryPort,
} from '../../domain/repositories/llm-usage.repository.port';
import { LlmUsageConfigService } from './llm-usage-config.service';

const CLEANUP_CONFIG: CleanupCronConfig = {
  name: 'llm-usage-cleanup',
  advisoryLockId: 300,
  cronExpression: '0 0 4 1 * *',
  timeZone: 'Asia/Ho_Chi_Minh',
  enabledConfigKey: 'LLM_USAGE_CLEANUP_ENABLED',
  retentionDaysConfigKey: 'LLM_USAGE_RETENTION_DAYS',
  defaultRetentionDays: 90,
};

@Injectable()
export class LlmUsageCleanupCronService {
  private readonly logger = new Logger(LlmUsageCleanupCronService.name);

  constructor(
    private readonly configService: ConfigService,
    private readonly llmConfig: LlmUsageConfigService,
    @Inject(LLM_USAGE_REPOSITORY)
    private readonly usageRepository: LlmUsageRepositoryPort,
    private readonly cleanupCron: CleanupCronService,
  ) {}

  isEnabled(): boolean {
    const raw = this.configService
      .get<string>(CLEANUP_CONFIG.enabledConfigKey)
      ?.trim()
      .toLowerCase();

    if (!raw) {
      return this.llmConfig.isEnabled();
    }

    return raw === 'true' || raw === '1' || raw === 'yes';
  }

  getRetentionDays(): number {
    return this.llmConfig.getRetentionDays();
  }

  /** Purge old LLM usage rows — 04:00 ICT on the 1st of each month. */
  @Cron(CLEANUP_CONFIG.cronExpression, {
    name: CLEANUP_CONFIG.name,
    timeZone: CLEANUP_CONFIG.timeZone,
  })
  async handleMonthlyCleanup(): Promise<void> {
    await this.cleanupCron.execute(
      CLEANUP_CONFIG,
      (cutoff) => this.usageRepository.deleteOlderThan(cutoff),
      () => this.isEnabled(),
      () => this.getRetentionDays(),
    );
  }
}
