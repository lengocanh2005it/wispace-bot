import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  LlmSafetyCore,
  LlmSafetyEventEntity,
  LlmSafetyEventRepository,
  type RecordGroundingWarningInput,
} from '@wispace/chat-metering';

const PLATFORM = 'zalo' as const;

/**
 * Thin NestJS adapter around `@wispace/chat-metering`'s safety-event
 * recorder — Zalo counterpart to messenger-bot's `LlmSafetyEventService`.
 */
@Injectable()
export class ZaloLlmSafetyEventService {
  private readonly logger = new Logger(ZaloLlmSafetyEventService.name);
  private core?: LlmSafetyCore;

  constructor(
    @InjectRepository(LlmSafetyEventEntity)
    private readonly repo: Repository<LlmSafetyEventEntity>,
  ) {}

  recordGroundingWarning(input: RecordGroundingWarningInput): void {
    this.getCore().recordGroundingWarning(input);
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
