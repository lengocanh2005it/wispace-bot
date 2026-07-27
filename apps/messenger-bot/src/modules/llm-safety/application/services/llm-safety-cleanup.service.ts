import { Inject, Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import {
  CleanupCronService,
  type CleanupCronConfig,
} from '@wispace/cleanup-cron';
import { ConfigService } from '@nestjs/config';
import {
  LLM_SAFETY_EVENT_REPOSITORY,
  type LlmSafetyEventRepositoryPort,
} from '../../domain/repositories/llm-safety-event.repository.port';

const CLEANUP_CONFIG: CleanupCronConfig = {
  name: 'llm-safety-cleanup',
  advisoryLockId: 400,
  cronExpression: '0 3 * * *',
  timeZone: 'Asia/Ho_Chi_Minh',
  enabledConfigKey: 'LLM_SAFETY_EVENTS_ENABLED',
  retentionDaysConfigKey: 'LLM_SAFETY_EVENT_RETENTION_DAYS',
  defaultRetentionDays: 30,
};

@Injectable()
export class LlmSafetyCleanupService {
  private readonly logger = new Logger(LlmSafetyCleanupService.name);

  constructor(
    private readonly configService: ConfigService,
    @Inject(LLM_SAFETY_EVENT_REPOSITORY)
    private readonly repository: LlmSafetyEventRepositoryPort,
    private readonly cleanupCron: CleanupCronService,
  ) {}

  isEnabled(): boolean {
    const raw = this.configService
      .get<string>(CLEANUP_CONFIG.enabledConfigKey)
      ?.trim()
      .toLowerCase();
    return raw !== 'false' && raw !== '0';
  }

  getRetentionDays(): number {
    const raw = this.configService
      .get<string>(CLEANUP_CONFIG.retentionDaysConfigKey)
      ?.trim();
    const value = Number(raw);
    return Number.isFinite(value) && value > 0
      ? Math.floor(value)
      : CLEANUP_CONFIG.defaultRetentionDays;
  }

  @Cron(CLEANUP_CONFIG.cronExpression, {
    name: CLEANUP_CONFIG.name,
    timeZone: CLEANUP_CONFIG.timeZone,
  })
  async runCleanup(): Promise<void> {
    await this.cleanupCron.execute(
      CLEANUP_CONFIG,
      async (cutoff) => this.repository.deleteOlderThan(cutoff),
      () => this.isEnabled(),
      () => this.getRetentionDays(),
    );
  }
}
