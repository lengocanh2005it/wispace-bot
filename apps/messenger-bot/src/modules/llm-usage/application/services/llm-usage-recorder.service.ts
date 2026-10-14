import {
  Inject,
  Injectable,
  Logger,
  type OnModuleDestroy,
} from '@nestjs/common';
import { errorMessage } from '@wispace/bot-common/masking';
import {
  DirectUsageWriter,
  LlmUsageRecorderCore,
} from '@wispace/chat-metering/core';
import type { LlmUsageRecorderMetrics } from '@wispace/chat-metering/core';
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
export class LlmUsageRecorderService implements OnModuleDestroy {
  private readonly logger = new Logger(LlmUsageRecorderService.name);
  private core?: LlmUsageRecorderCore;
  private writer?: DirectUsageWriter;

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
      provider: input.provider,
      model: input.model,
      response: input.response,
      correlationId: input.correlationId,
      toolRound: input.toolRound,
      status: input.status,
      errorMessage: input.errorMessage,
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
            input.provider,
          );

    const { psid, ...usage } = input;
    this.getWriter().write({
      ...usage,
      externalUserId: psid,
      estimatedCostUsd,
      usageDate: this.configService.todayUsageDate(),
    });
  }

  private getCore(): LlmUsageRecorderCore {
    if (!this.core) {
      this.core = new LlmUsageRecorderCore(
        this.getWriter(),
        (model, promptTokens, completionTokens, cachedTokens, provider) =>
          this.configService.estimateCostUsdForModel(
            model,
            promptTokens,
            completionTokens,
            cachedTokens,
            provider,
          ),
        () => this.configService.todayUsageDate(),
        { warn: (m) => this.logger.warn(m) },
        this.buildMetrics(),
      );
    }
    return this.core;
  }

  private getWriter(): DirectUsageWriter {
    if (!this.writer) {
      this.writer = new DirectUsageWriter(
        {
          insertUsage: (event) => {
            const { externalUserId, ...usage } = event;
            return this.repository.insertUsage({
              ...usage,
              feature: usage.feature as RecordLlmUsageInput['feature'],
              psid: externalUserId,
            });
          },
        },
        (error, event) => {
          this.logger.error(
            `LLM_USAGE_INSERT_FAILED feature=${event.feature} correlation=${event.correlationId ?? 'n/a'}: ${errorMessage(
              error,
            )}`,
          );
          this.metrics.incLlmUsageInsertFailure('db_error');
        },
      );
    }
    return this.writer;
  }

  onModuleDestroy(): void {
    this.writer?.dispose();
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
