import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import type { ChatCompletion } from 'openai/resources/chat/completions';
import {
  DirectUsageWriter,
  LlmUsageEventEntity,
  LlmUsageRecorderCore,
  LlmUsageRepository,
} from '@wispace/chat-metering';
import { ZaloLlmUsageConfigService } from '../../application/services/zalo-llm-usage-config.service';

const PLATFORM = 'zalo' as const;

export interface RecordLlmUsageFromCompletionInput {
  feature: string;
  zaloUserId: string;
  userId?: number;
  model: string;
  response: Pick<ChatCompletion, 'id' | 'usage'>;
  correlationId?: string;
  toolRound?: number;
}

/**
 * Thin NestJS adapter around `@wispace/chat-metering`'s LLM usage recorder —
 * Zalo counterpart to messenger-bot's `LlmUsageRecorderService`.
 */
@Injectable()
export class ZaloLlmUsageRecorderService {
  private readonly logger = new Logger(ZaloLlmUsageRecorderService.name);
  private core?: LlmUsageRecorderCore;

  constructor(
    private readonly configService: ZaloLlmUsageConfigService,
    @InjectRepository(LlmUsageEventEntity)
    private readonly usageRepo: Repository<LlmUsageEventEntity>,
  ) {}

  recordFromCompletion(input: RecordLlmUsageFromCompletionInput): void {
    if (!this.configService.isEnabled()) {
      return;
    }

    this.getCore().recordFromCompletion({
      feature: input.feature,
      externalUserId: input.zaloUserId,
      userId: input.userId,
      model: input.model,
      response: input.response,
      correlationId: input.correlationId,
      toolRound: input.toolRound,
    });
  }

  private getCore(): LlmUsageRecorderCore {
    if (!this.core) {
      const repository = new LlmUsageRepository(this.usageRepo, PLATFORM);
      const writer = new DirectUsageWriter(repository, (error) => {
        this.logger.warn(
          `LLM_USAGE_INSERT_FAILED: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });

      this.core = new LlmUsageRecorderCore(
        writer,
        (model, promptTokens, completionTokens, cachedTokens) =>
          this.configService.estimateCostUsdForModel(
            model,
            promptTokens,
            completionTokens,
            cachedTokens,
          ),
        () => this.configService.todayUsageDate(),
        { warn: (m) => this.logger.warn(m) },
      );
    }

    return this.core;
  }
}
