import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import {
  Registry,
  Counter,
  Gauge,
  Histogram,
  collectDefaultMetrics,
} from 'prom-client';
import type {
  Tracer,
  SpanStatusCode,
  ContextAPI,
  TraceAPI,
} from '@opentelemetry/api';

export interface MetricsConfig {
  /** Prefix for metric names (e.g., 'messenger', 'discord', 'zalo') */
  prefix: string;
  /** Whether to collect default Node.js metrics */
  collectDefaults?: boolean;
  /** Optional OTel tracer for distributed tracing (pass trace.getTracer('service-name')) */
  tracer?: Tracer;
  /** OTel SpanStatusCode values (pass SpanStatusCode from @opentelemetry/api) */
  spanStatusCode?: typeof SpanStatusCode;
  /** OTel context API (pass context from @opentelemetry/api) */
  contextApi?: ContextAPI;
  /** OTel trace API (pass trace from @opentelemetry/api) */
  traceApi?: TraceAPI;
}

/**
 * Platform-agnostic Prometheus metrics with optional OpenTelemetry tracing.
 * When `tracer` is provided in config, all timing methods also emit OTel spans.
 */
@Injectable()
export class BotMetricsService implements OnModuleDestroy {
  private readonly logger = new Logger(BotMetricsService.name);
  readonly registry: Registry;
  private readonly prefix: string;
  private readonly tracer: MetricsConfig['tracer'];
  private readonly spanStatusCode: MetricsConfig['spanStatusCode'];
  private readonly contextApi: MetricsConfig['contextApi'];
  private readonly traceApi: MetricsConfig['traceApi'];

  private chatStepDuration: Histogram;
  private llmCallDuration: Histogram;
  private llmExecutionDuration: Histogram;
  private llmToolDuration: Histogram;
  private llmToolCalls: Counter;
  private llmRoundOutcome: Counter;
  private quotaDenied: Counter;
  private reminderDispatch: Counter;
  private dmDeliveryFailures: Counter;
  private welcomeAttempts: Counter;
  private tokenRefreshFailures: Counter;
  private webhookInboundBacklog: Gauge;
  private wispaceCallDuration: Histogram;
  private llmUsageInsertFailures: Counter;
  private llmMissingTokens: Counter;
  private llmUnpricedModelTokens: Counter;

  constructor(config: MetricsConfig) {
    this.prefix = config.prefix;
    this.tracer = config.tracer;
    this.spanStatusCode = config.spanStatusCode;
    this.contextApi = config.contextApi;
    this.traceApi = config.traceApi;
    this.registry = new Registry();

    if (config.collectDefaults !== false) {
      collectDefaultMetrics({ register: this.registry });
    }

    if (this.tracer) {
      this.logger.log('BotMetricsService: OTel tracing enabled');
    }

    this.chatStepDuration = new Histogram({
      name: `${this.prefix}_chat_step_duration_seconds`,
      help: 'Duration of chat pipeline steps',
      labelNames: ['step', 'status'],
      buckets: [0.01, 0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });

    this.llmCallDuration = new Histogram({
      name: `${this.prefix}_llm_call_duration_seconds`,
      help: 'Duration of LLM API calls',
      labelNames: ['feature', 'model', 'round', 'status'],
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60],
      registers: [this.registry],
    });

    this.llmExecutionDuration = new Histogram({
      name: `${this.prefix}_llm_execution_duration_seconds`,
      help: 'Duration of LLM requests at execution-service layer',
      labelNames: ['feature', 'status'],
      buckets: [0.1, 0.25, 0.5, 1, 2, 5, 10, 20, 30, 60],
      registers: [this.registry],
    });

    this.llmToolDuration = new Histogram({
      name: `${this.prefix}_llm_tool_duration_seconds`,
      help: 'Duration of LLM tool executions',
      labelNames: ['tool_name', 'status'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 20],
      registers: [this.registry],
    });

    this.llmToolCalls = new Counter({
      name: `${this.prefix}_llm_tool_calls_total`,
      help: 'Total LLM tool invocations',
      labelNames: ['tool_name', 'status'],
      registers: [this.registry],
    });

    this.llmRoundOutcome = new Counter({
      name: `${this.prefix}_llm_round_outcome_total`,
      help: 'LLM agent round outcomes',
      labelNames: ['feature', 'outcome'],
      registers: [this.registry],
    });

    this.quotaDenied = new Counter({
      name: `${this.prefix}_chat_quota_denied_total`,
      help: 'Chat quota denied events',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.reminderDispatch = new Counter({
      name: `${this.prefix}_reminder_dispatch_total`,
      help: 'Study reminder dispatch outcomes',
      labelNames: ['status'],
      registers: [this.registry],
    });

    this.dmDeliveryFailures = new Counter({
      name: `${this.prefix}_dm_delivery_failures_total`,
      help: 'Direct-message delivery failures (privacy-blocked DMs, Discord API errors)',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.welcomeAttempts = new Counter({
      name: `${this.prefix}_welcome_attempts_total`,
      help: 'Welcome DM delivery outcomes (skipped = deduped within the re-welcome window)',
      labelNames: ['outcome'],
      registers: [this.registry],
    });

    this.tokenRefreshFailures = new Counter({
      name: `${this.prefix}_token_refresh_failures_total`,
      help: 'OAuth token refresh failures (timeout, consumed token, network error)',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.webhookInboundBacklog = new Gauge({
      name: `${this.prefix}_webhook_inbound_backlog`,
      help: 'Durable inbound webhook events due for retry (pending/failed/processing-stale)',
      registers: [this.registry],
    });

    this.wispaceCallDuration = new Histogram({
      name: `${this.prefix}_wispace_call_duration_seconds`,
      help: 'Duration of WISPACE upstream API calls',
      labelNames: ['service', 'operation', 'status'],
      buckets: [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 30],
      registers: [this.registry],
    });

    this.llmUsageInsertFailures = new Counter({
      name: `${this.prefix}_llm_usage_insert_failures_total`,
      help: 'LLM usage event database insert failures',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.llmMissingTokens = new Counter({
      name: `${this.prefix}_llm_missing_tokens_total`,
      help: 'LLM responses missing token usage data',
      labelNames: ['feature'],
      registers: [this.registry],
    });

    this.llmUnpricedModelTokens = new Counter({
      name: `${this.prefix}_llm_unpriced_model_tokens_total`,
      help: 'LLM tokens processed for models with no configured pricing',
      labelNames: ['model'],
      registers: [this.registry],
    });
  }

  async timeStep<T>(step: string, fn: () => Promise<T>): Promise<T> {
    const span = this.tracer?.startSpan(`chat.${step}`);
    const end = this.chatStepDuration.startTimer({ step });
    return this.withSpan(span, fn, (status) => {
      end({ status });
    });
  }

  async timeLlmCall<T>(
    feature: string,
    model: string,
    round: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    const span = this.tracer?.startSpan(`llm.call.round_${round}`);
    span?.setAttributes({
      'llm.feature': feature,
      'llm.model': model,
      'llm.round': round,
    });
    const end = this.llmCallDuration.startTimer({
      feature,
      model,
      round: String(round),
    });
    return this.withSpan(span, fn, (status) => {
      end({ status });
    });
  }

  async timeLlmExecution<T>(feature: string, fn: () => Promise<T>): Promise<T> {
    const span = this.tracer?.startSpan('llm.execution');
    span?.setAttribute('llm.feature', feature);
    const end = this.llmExecutionDuration.startTimer({ feature });
    return this.withSpan(span, fn, (status) => {
      end({ status });
    });
  }

  async timeWispaceCall<T>(
    service: string,
    operation: string,
    fn: () => Promise<T>,
  ): Promise<T> {
    const span = this.tracer?.startSpan(`wispace.${service}.${operation}`);
    span?.setAttributes({
      'wispace.service': service,
      'wispace.operation': operation,
    });
    const end = this.wispaceCallDuration.startTimer({
      service,
      operation,
    });
    return this.withSpan(span, fn, (status) => {
      end({ status });
    });
  }

  async timeTool<T>(toolName: string, fn: () => Promise<T>): Promise<T> {
    const span = this.tracer?.startSpan(`llm.tool.${toolName}`);
    span?.setAttribute('llm.tool_name', toolName);
    const end = this.llmToolDuration.startTimer({ tool_name: toolName });
    return this.withSpan(span, fn, (status) => {
      end({ status });
      this.llmToolCalls.inc({ tool_name: toolName, status });
    });
  }

  incQuotaDenied(reason: string): void {
    this.quotaDenied.inc({ reason });
  }

  incReminderDispatch(status: string): void {
    this.reminderDispatch.inc({ status });
  }

  /** DM delivery failure (e.g. user privacy settings block DMs) — ops signal. */
  incDmDeliveryFailure(reason: string): void {
    this.dmDeliveryFailures.inc({ reason });
  }

  /** Welcome-DM attempt outcome — success | error | skipped (#232/#234). */
  incWelcomeAttempt(outcome: string): void {
    this.welcomeAttempts.inc({ outcome });
  }

  /** OAuth token refresh failure — timeout, consumed token, network error (#154). */
  incTokenRefreshFailure(reason: string): void {
    this.tokenRefreshFailures.inc({ reason });
  }

  /** Backlog gauge for the durable inbound retry cron — set per tick. */
  setWebhookInboundBacklog(dueCount: number): void {
    this.webhookInboundBacklog.set(dueCount);
  }

  incRoundOutcome(feature: string, outcome: string): void {
    this.llmRoundOutcome.inc({ feature, outcome });
  }

  /** LLM usage event database insert failure — ops signal for telemetry loss. */
  incLlmUsageInsertFailure(reason: string): void {
    this.llmUsageInsertFailures.inc({ reason });
  }

  /** LLM response missing token usage data — ops signal. */
  incLlmMissingTokens(feature: string): void {
    this.llmMissingTokens.inc({ feature });
  }

  /** LLM tokens processed for a model with no configured pricing. */
  incLlmUnpricedModelTokens(model: string): void {
    this.llmUnpricedModelTokens.inc({ model });
  }

  async getMetrics(): Promise<string> {
    return this.registry.metrics();
  }

  contentType(): string {
    return this.registry.contentType;
  }

  onModuleDestroy(): void {
    this.registry.clear();
  }

  /**
   * Execute fn within an OTel span context, recording status and exceptions.
   * Falls back to direct execution when OTel is not configured.
   */
  private async withSpan<T>(
    span:
      | ReturnType<NonNullable<MetricsConfig['tracer']>['startSpan']>
      | undefined,
    fn: () => Promise<T>,
    onResult: (status: string) => void,
  ): Promise<T> {
    if (!span || !this.contextApi || !this.traceApi || !this.spanStatusCode) {
      try {
        const result = await fn();
        onResult('ok');
        return result;
      } catch (error) {
        onResult('error');
        throw error;
      }
    }

    return this.contextApi.with(
      this.traceApi.setSpan(this.contextApi.active(), span),
      async () => {
        try {
          const result = await fn();
          onResult('ok');
          span.setStatus({ code: this.spanStatusCode!.OK });
          return result;
        } catch (err) {
          onResult('error');
          span.setStatus({
            code: this.spanStatusCode!.ERROR,
            message: String(err),
          });
          span.recordException(err as Error);
          throw err;
        } finally {
          span.end();
        }
      },
    );
  }
}
