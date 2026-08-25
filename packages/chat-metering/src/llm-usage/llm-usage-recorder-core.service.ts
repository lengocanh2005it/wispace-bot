import type { UsageWriterPort } from './types';

export interface RecordLlmUsageFromCompletionInput {
  feature: string;
  externalUserId?: string;
  userId?: number;
  model: string;
  response: { id: string; usage?: unknown };
  correlationId?: string;
  toolRound?: number;
}

interface OpenAiUsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface LlmUsageRecorderLogger {
  warn(message: string): void;
}

export interface LlmUsageRecorderMetrics {
  incMissingTokens(feature: string): void;
  incUnpricedModelTokens(model: string): void;
  incInsertFailure(reason: string): void;
}

const NOOP_LOGGER: LlmUsageRecorderLogger = { warn: () => undefined };

/**
 * Platform-agnostic LLM token/cost recorder — computes the event payload
 * (cost estimate via caller-supplied pricing function) and hands it to a
 * `UsageWriterPort` (direct insert, or an app's own queued writer).
 */
export class LlmUsageRecorderCore {
  constructor(
    private readonly writer: UsageWriterPort,
    private readonly estimateCostUsdForModel: (
      model: string,
      promptTokens: number,
      completionTokens: number,
      cachedTokens?: number,
    ) => string | null,
    private readonly todayUsageDate: () => string,
    private readonly logger: LlmUsageRecorderLogger = NOOP_LOGGER,
    private readonly metrics?: LlmUsageRecorderMetrics,
  ) {}

  /** Non-blocking. */
  recordFromCompletion(input: RecordLlmUsageFromCompletionInput): void {
    const usage = input.response.usage as OpenAiUsageShape | undefined;
    if (!usage) {
      this.logger.warn(
        `LLM_USAGE_MISSING_TOKENS feature=${input.feature} correlation=${input.correlationId ?? 'n/a'}`,
      );
      this.metrics?.incMissingTokens(input.feature);
    }

    const promptTokens = usage?.prompt_tokens ?? 0;
    const completionTokens = usage?.completion_tokens ?? 0;
    const cachedTokens = usage?.prompt_tokens_details?.cached_tokens ?? 0;

    const estimatedCostUsd = this.estimateCostUsdForModel(
      input.model,
      promptTokens,
      completionTokens,
      cachedTokens,
    );

    if (
      estimatedCostUsd === null &&
      (promptTokens > 0 || completionTokens > 0)
    ) {
      this.logger.warn(
        `LLM_UNPRICED_MODEL model=${input.model} feature=${input.feature}`,
      );
      this.metrics?.incUnpricedModelTokens(input.model);
    }

    this.writer.write({
      feature: input.feature,
      externalUserId: input.externalUserId,
      userId: input.userId,
      model: input.model,
      promptTokens,
      completionTokens,
      totalTokens: usage?.total_tokens ?? 0,
      cachedTokens,
      openaiResponseId: input.response.id,
      correlationId: input.correlationId,
      toolRound: input.toolRound,
      estimatedCostUsd,
      usageDate: this.todayUsageDate(),
    });
  }
}
