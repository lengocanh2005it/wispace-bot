import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  LlmSafetyCore,
  LlmSafetyEventEntity,
  LlmSafetyEventRepository,
} from '@wispace/chat-metering';
import { subHours, subDays } from 'date-fns';
import type { RecordGroundingWarningInput } from './llm-safety.types';

const PLATFORM = 'messenger' as const;

@Injectable()
export class LlmSafetyService {
  private readonly logger = new Logger(LlmSafetyService.name);
  private readonly retentionDays: number;
  private core?: LlmSafetyCore;

  constructor(
    private readonly configService: ConfigService,
    @InjectRepository(LlmSafetyEventEntity)
    private readonly repo: Repository<LlmSafetyEventEntity>,
  ) {
    const raw = this.configService
      .get<string>('LLM_SAFETY_EVENT_RETENTION_DAYS')
      ?.trim();
    const val = raw ? Number(raw) : NaN;
    this.retentionDays = Number.isFinite(val) && val > 0 ? Math.floor(val) : 30;
  }

  isEnabled(): boolean {
    const raw = this.configService
      .get<string>('LLM_SAFETY_EVENTS_ENABLED')
      ?.trim()
      .toLowerCase();
    return raw !== 'false' && raw !== '0';
  }

  /** Best-effort — never throws. Delegates to the shared LlmSafetyCore. */
  recordGroundingWarning(input: RecordGroundingWarningInput): void {
    if (!this.isEnabled()) return;
    this.getCore().recordGroundingWarning({
      externalUserId: input.psid,
      userId: input.userId,
      correlationId: input.correlationId,
      reason: input.reason,
      userTextPreview: input.userTextPreview,
      assistantTextPreview: input.assistantTextPreview,
      toolNamesUsed: input.toolNamesUsed,
    });
  }

  async countWarnings24h(): Promise<number> {
    if (!this.isEnabled()) return 0;
    const since = subHours(new Date(), 24);
    return this.getCore().countWarningsSince(since);
  }

  async deleteOlderThanRetentionDays(): Promise<number> {
    const before = subDays(new Date(), this.retentionDays);
    const deleted = await this.getCore().deleteOlderThan(before);
    if (deleted > 0)
      this.logger.log(
        `LLM_SAFETY_CLEANUP deleted=${deleted} older_than_days=${this.retentionDays}`,
      );
    return deleted;
  }

  readWarningDailyThreshold(): number {
    const raw = this.configService
      .get<string>('LLM_SAFETY_WARNING_DAILY_THRESHOLD')
      ?.trim();
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 5;
  }

  @Cron('0 3 * * *', {
    name: 'llm-safety-cleanup',
    timeZone: 'Asia/Ho_Chi_Minh',
  })
  async runCleanup(): Promise<void> {
    if (!this.isEnabled()) return;
    await this.deleteOlderThanRetentionDays();
  }

  private getCore(): LlmSafetyCore {
    if (!this.core) {
      this.core = new LlmSafetyCore(
        new LlmSafetyEventRepository(this.repo, PLATFORM),
        {
          warn: (m) => this.logger.warn(m),
          log: (m) => this.logger.log(m),
        },
      );
    }
    return this.core;
  }
}
