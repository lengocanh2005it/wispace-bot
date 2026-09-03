import type { LlmUsage } from '@wispace/llm-agent';
import type { UsageWriterPort } from './types';

export interface RecordLlmUsageFromCompletionInput {
  feature: string;
  externalUserId?: string;
  userId?: number;
  provider?: string;
  model: string;
  /**
   * Provider-neutral completion snapshot — the OpenAI adapter maps its
   * native usage into `LlmUsage` at the outer boundary (#427); the usage
   * domain never sees provider-specific response shapes.
   */
  response: { id: string; usage?: LlmUsage | null };
  correlationId?: string;
  toolRound?: number;
  /** #549 — zero-token failure row marker; error class enum, never raw text. */
  status?: 'ok' | 'error';
  errorMessage?: string;
}

export interface LlmUsageRecorderLogger {
  warn(message: string): void;
}

export interface LlmUsageRecorderMetrics {
  incMissingTokens(feature: string): void;
  incUnpricedModelTokens(model: string): void;
  incInsertFailure(reason: string): void;
}

/**
 * Structural source type for #549 wiring — matches `BotMetricsService`
 * method-for-method without importing `@wispace/bot-metrics` (no new
 * package edge; the app side passes its metrics service directly).
 */
export interface BotMetricsUsageRecorderSource {
  incLlmMissingTokens(feature: string): void;
  incLlmUnpricedModelTokens(model: string): void;
  incLlmUsageInsertFailure(reason: string): void;
}

/**
 * #549 — adapts the app metrics service to the recorder's metrics port.
 * Used at every recorder construction site so the counters stop being
 * permanent no-ops.
 */
export function toUsageRecorderMetrics(
  source: BotMetricsUsageRecorderSource,
): LlmUsageRecorderMetrics {
  return {
    incMissingTokens: (feature) => source.incLlmMissingTokens(feature),
    incUnpricedModelTokens: (model) => source.incLlmUnpricedModelTokens(model),
    incInsertFailure: (reason) => source.incLlmUsageInsertFailure(reason),
  };
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
    const usage = input.response.usage;
    if (!usage) {
      this.logger.warn(
        `LLM_USAGE_MISSING_TOKENS feature=${input.feature} correlation=${input.correlationId ?? 'n/a'}`,
      );
      this.metrics?.incMissingTokens(input.feature);
    }

    const promptTokens = usage?.promptTokens ?? 0;
    const completionTokens = usage?.completionTokens ?? 0;
    const cachedTokens = usage?.cachedTokens ?? 0;

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
      provider: input.provider ?? 'unknown',
      model: input.model,
      promptTokens,
      completionTokens,
      totalTokens: usage?.totalTokens ?? 0,
      cachedTokens,
      openaiResponseId: input.response.id,
      correlationId: input.correlationId,
      toolRound: input.toolRound,
      status: input.status,
      errorMessage: input.errorMessage,
      estimatedCostUsd,
      usageDate: this.todayUsageDate(),
    });
  }

  /** Forward shutdown to the underlying writer. */
  dispose(): void {
    const w = this.writer as unknown as { dispose?: () => void };
    if (typeof w.dispose === 'function') {
      w.dispose();
    }
  }
}
