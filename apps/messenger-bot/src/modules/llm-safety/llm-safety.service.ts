import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { LessThan, MoreThan, Repository } from 'typeorm';
import { LlmSafetyEventEntity } from '@wispace/chat-metering';
import type { RecordGroundingWarningInput } from './llm-safety.types';

const PLATFORM = 'messenger' as const;

@Injectable()
export class LlmSafetyService {
  private readonly logger = new Logger(LlmSafetyService.name);
  private readonly retentionDays: number;

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

  /** Best-effort — never throws. */
  recordGroundingWarning(input: RecordGroundingWarningInput): void {
    if (!this.isEnabled()) return;

    const payload: Record<string, unknown> = {
      toolNamesUsed: input.toolNamesUsed,
    };
    if (input.userTextPreview)
      payload['userTextPreview'] = input.userTextPreview.slice(0, 200);
    if (input.assistantTextPreview)
      payload['assistantTextPreview'] = input.assistantTextPreview.slice(
        0,
        200,
      );

    const entity = this.repo.create({
      platform: PLATFORM,
      externalUserId: input.psid,
      userId: input.userId,
      correlationId: input.correlationId,
      feature: 'FREE_FORM_CHAT',
      eventType: 'GROUNDING_WARNING',
      reason: input.reason,
      payload: payload ?? null,
    });
    this.repo.save(entity).catch((err: unknown) => {
      this.logger.warn(
        `recordGroundingWarning failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  async countWarnings24h(): Promise<number> {
    if (!this.isEnabled()) return 0;
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
    return this.repo.count({
      where: { platform: PLATFORM, createdAt: MoreThan(since) },
    });
  }

  async deleteOlderThanRetentionDays(): Promise<number> {
    const before = new Date(
      Date.now() - this.retentionDays * 24 * 60 * 60 * 1000,
    );
    const result = await this.repo.delete({
      platform: PLATFORM,
      createdAt: LessThan(before),
    });
    const deleted = result.affected ?? 0;
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
}
