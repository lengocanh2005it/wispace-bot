import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { hoursAgo } from '@wispace/date-utils';
import { LlmSafetyEventEntity } from '../entities';
import { LlmSafetyCore } from './llm-safety-core.service';
import { LlmSafetyEventRepository } from './llm-safety.repository';
import type { RecordGroundingWarningInput } from './types';

/**
 * Thin NestJS adapter around `LlmSafetyCore` — shared by Discord and Zalo.
 * Platform (`'discord'` / `'zalo'`) parameterizes the persisted event row.
 */
@Injectable()
export class PlatformLlmSafetyEventAdapter {
  private readonly logger = new Logger(PlatformLlmSafetyEventAdapter.name);
  private core?: LlmSafetyCore;

  constructor(
    private readonly platform: string,
    @InjectRepository(LlmSafetyEventEntity)
    private readonly repo: Repository<LlmSafetyEventEntity>,
    private readonly configService: ConfigService,
  ) {}

  recordGroundingWarning(input: RecordGroundingWarningInput): void {
    this.getCore().recordGroundingWarning(input);
  }

  async countWarnings24h(): Promise<number> {
    const since = hoursAgo(24);
    return this.getCore().countWarningsSince(since);
  }

  readWarningDailyThreshold(): number {
    const raw = this.configService
      .get<string>('LLM_SAFETY_WARNING_DAILY_THRESHOLD')
      ?.trim();
    const value = Number(raw);
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 5;
  }

  private getCore(): LlmSafetyCore {
    if (!this.core) {
      const repository = new LlmSafetyEventRepository(this.repo, this.platform);
      this.core = new LlmSafetyCore(repository, {
        warn: (m) => this.logger.warn(m),
        log: (m) => this.logger.log(m),
      });
    }
    return this.core;
  }
}
