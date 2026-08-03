import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import {
  DirectUsageWriter,
  LlmUsageEventEntity,
  LlmUsageRecorderCore,
  LlmUsageRepository,
} from '@wispace/chat-metering';
import { LlmUsageConfigService } from './llm-usage-config.service';
import type { RecordLlmUsageFromCompletionInput } from './discord-llm-usage-recorder.types';

const PLATFORM = 'discord' as const;

/**
 * Thin NestJS adapter around `@wispace/chat-metering`'s LLM usage recorder —
 * Discord counterpart to messenger-bot's `LlmUsageRecorderService`. MVP:
 * direct fire-and-forget insert (no BullMQ queue/retry yet).
 */
@Injectable()
export class DiscordLlmUsageRecorderService {
  private readonly logger = new Logger(DiscordLlmUsageRecorderService.name);
  private core?: LlmUsageRecorderCore;

  constructor(
    private readonly configService: LlmUsageConfigService,
    @InjectRepository(LlmUsageEventEntity)
    private readonly usageRepo: Repository<LlmUsageEventEntity>,
  ) {}

  recordFromCompletion(input: RecordLlmUsageFromCompletionInput): void {
    if (!this.configService.isEnabled()) {
      return;
    }

    this.getCore().recordFromCompletion({
      feature: input.feature,
      externalUserId: input.discordUserId,
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
