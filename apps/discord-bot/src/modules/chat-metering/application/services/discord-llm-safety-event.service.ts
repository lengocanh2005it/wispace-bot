import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  LlmSafetyCore,
  LlmSafetyEventEntity,
  LlmSafetyEventRepository,
  type RecordGroundingWarningInput,
} from '@wispace/chat-metering';

const PLATFORM = 'discord' as const;

@Injectable()
export class DiscordLlmSafetyEventService {
  private readonly logger = new Logger(DiscordLlmSafetyEventService.name);
  private core?: LlmSafetyCore;

  constructor(
    @InjectRepository(LlmSafetyEventEntity)
    private readonly repo: Repository<LlmSafetyEventEntity>,
    private readonly configService: ConfigService,
  ) {}

  recordGroundingWarning(input: RecordGroundingWarningInput): void {
    this.getCore().recordGroundingWarning(input);
  }

  async countWarnings24h(): Promise<number> {
    const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
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
      const repository = new LlmSafetyEventRepository(this.repo, PLATFORM);
      this.core = new LlmSafetyCore(repository, {
        warn: (m) => this.logger.warn(m),
        log: (m) => this.logger.log(m),
      });
    }
    return this.core;
  }
}
