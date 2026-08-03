import { Inject, Injectable, Logger } from '@nestjs/common';
import type {
  RecordLlmUsageFromCompletionInput,
  RecordLlmUsageInput,
} from '../../domain/entities/llm-usage.types';
import {
  LLM_USAGE_REPOSITORY,
  type LlmUsageRepositoryPort,
} from '../../domain/repositories/llm-usage.repository.port';
import { LlmUsageConfigService } from './llm-usage-config.service';

@Injectable()
export class LlmUsageRecorderService {
  private readonly logger = new Logger(LlmUsageRecorderService.name);

  constructor(
    private readonly configService: LlmUsageConfigService,
    @Inject(LLM_USAGE_REPOSITORY)
    private readonly repository: LlmUsageRepositoryPort,
  ) {}

  isEnabled(): boolean {
    return this.configService.isEnabled();
  }

  /** Non-blocking — extracts usage from OpenAI response and inserts. */
  recordFromCompletion(input: RecordLlmUsageFromCompletionInput): void {
    const usage = input.response.usage;
    if (!usage) {
      this.logger.warn(
        `LLM_USAGE_MISSING_TOKENS feature=${input.feature} correlation=${input.correlationId ?? 'n/a'}`,
      );
    }

    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;

    this.recordUsage({
      feature: input.feature,
      psid: input.psid,
      userId: input.userId,
      model: input.model,
      promptTokens: usage?.prompt_tokens ?? 0,
      completionTokens: usage?.completion_tokens ?? 0,
      totalTokens: usage?.total_tokens ?? 0,
      cachedTokens,
      openaiResponseId: input.response.id,
      correlationId: input.correlationId,
      toolRound: input.toolRound,
      estimatedCostUsd: this.configService.estimateCostUsdForModel(
        input.model,
        usage?.prompt_tokens ?? 0,
        usage?.completion_tokens ?? 0,
        cachedTokens,
      ),
    });
  }

  /** Non-blocking — fire-and-forget insert directly to DB. */
  // ponytail: removed BullMQ queue, inline insert enough for current volume. Add queue when throughput justifies Redis/BullMQ overhead.
  recordUsage(input: RecordLlmUsageInput): void {
    if (!this.isEnabled()) {
      return;
    }

    const estimatedCostUsd =
      input.estimatedCostUsd !== undefined
        ? input.estimatedCostUsd
        : this.configService.estimateCostUsdForModel(
            input.model,
            input.promptTokens,
            input.completionTokens,
            input.cachedTokens,
          );

    this.repository
      .insertUsage({
        ...input,
        estimatedCostUsd,
        usageDate: this.configService.todayUsageDate(),
      })
      .catch((error: unknown) => {
        this.logger.error(
          `LLM_USAGE_INSERT_FAILED feature=${input.feature} correlation=${input.correlationId ?? 'n/a'}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      });
  }
}
