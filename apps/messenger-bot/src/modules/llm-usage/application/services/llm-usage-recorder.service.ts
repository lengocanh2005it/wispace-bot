import { Inject, Injectable, Logger } from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common/masking';
import {
  LlmUsageRecorderCore,
  type UsageWriterPort,
  type LlmUsageRecorderMetrics,
} from '@wispace/chat-metering';
import type {
  RecordLlmUsageFromCompletionInput,
  RecordLlmUsageInput,
} from '../../domain/entities/llm-usage.types';
import {
  LLM_USAGE_REPOSITORY,
  type LlmUsageRepositoryPort,
} from '../../domain/repositories/llm-usage.repository.port';
import { LlmUsageConfigService } from './llm-usage-config.service';
import { BotMetricsService } from '@wispace/bot-metrics';

@Injectable()
export class LlmUsageRecorderService {
  private readonly logger = new Logger(LlmUsageRecorderService.name);
  private core?: LlmUsageRecorderCore;

  constructor(
    private readonly configService: LlmUsageConfigService,
    @Inject(LLM_USAGE_REPOSITORY)
    private readonly repository: LlmUsageRepositoryPort,
    private readonly metrics: BotMetricsService,
  ) {}

  isEnabled(): boolean {
    return this.configService.isEnabled();
  }

  /** Non-blocking — extracts usage from OpenAI response and inserts. */
  recordFromCompletion(input: RecordLlmUsageFromCompletionInput): void {
    if (!this.isEnabled()) return;
    this.getCore().recordFromCompletion({
      feature: input.feature,
      externalUserId: input.psid,
      userId: input.userId,
      model: input.model,
      response: input.response,
      correlationId: input.correlationId,
      toolRound: input.toolRound,
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
          `LLM_USAGE_INSERT_FAILED feature=${input.feature} correlation=${input.correlationId ?? 'n/a'}: ${errorMessage(
            error,
          )}`,
        );
        this.metrics.incLlmUsageInsertFailure('db_error');
      });
  }

  private getCore(): LlmUsageRecorderCore {
    if (!this.core) {
      const writer: UsageWriterPort = {
        write: (event) => {
          this.repository
            .insertUsage({
              feature: event.feature as RecordLlmUsageInput['feature'],
              psid: event.externalUserId,
              userId: event.userId,
              model: event.model,
              promptTokens: event.promptTokens,
              completionTokens: event.completionTokens,
              totalTokens: event.totalTokens,
              cachedTokens: event.cachedTokens,
              openaiResponseId: event.openaiResponseId,
              correlationId: event.correlationId,
              toolRound: event.toolRound,
              estimatedCostUsd: event.estimatedCostUsd,
              usageDate: event.usageDate,
            })
            .catch((error: unknown) => {
              this.logger.error(
                `LLM_USAGE_INSERT_FAILED feature=${event.feature} correlation=${event.correlationId ?? 'n/a'}: ${errorMessage(
                  error,
                )}`,
              );
            });
        },
      };

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
        this.buildMetrics(),
      );
    }
    return this.core;
  }

  private buildMetrics(): LlmUsageRecorderMetrics {
    return {
      incMissingTokens: (feature) => this.metrics.incLlmMissingTokens(feature),
      incUnpricedModelTokens: (model) =>
        this.metrics.incLlmUnpricedModelTokens(model),
      incInsertFailure: (reason) =>
        this.metrics.incLlmUsageInsertFailure(reason),
    };
  }
}
