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
  private llmObservationOutcome: Counter;
  private llmToolPolicyDenied: Counter;
  private llmInjectionBlocked: Counter;
  private clarificationOutcomes: Counter;
  private llmAdmissionRejected: Counter;
  private llmAdmissionWait: Histogram;
  private llmAdmissionQueueDepth: Gauge;
  private llmProviderAttempts: Counter;
  private llmProviderCircuitEvents: Counter;
  private llmProvidersExhausted: Counter;
  private llmDegradedMode: Counter;
  private quotaDenied: Counter;
  private writeToolBudgetDenied: Counter;
  private reminderDispatch: Counter;
  private webActivityWebhookReceived: Counter;
  private scheduledSendSuppressed: Counter;
  private dmDeliveryFailures: Counter;
  private outboundActionNeutralized: Counter;
  private welcomeAttempts: Counter;
  private tokenRefreshFailures: Counter;
  private webhookInboundBacklog: Gauge;
  private wispaceCallDuration: Histogram;
  private llmUsageInsertFailures: Counter;
  private llmMissingTokens: Counter;
  private llmUnpricedModelTokens: Counter;
  private dbCircuitBreakerState: Gauge;
  private dbCircuitBreakerFailures: Counter;
  private chatIdentityStaleDetected: Counter;
  private chatRevalidationSkip: Counter;
  private chatFlushRecovery: Counter;
  private platformLinkTransitions: Counter;
  private dataQualityCheckStatus: Gauge;
  private dataQualityRuns: Counter;
  private dataQualityFailures: Counter;
  private llmClassifierVerdict: Counter<string>;
  private outboundRateLimitDecisions: Counter<string>;

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

    this.llmObservationOutcome = new Counter({
      name: `${this.prefix}_llm_observation_outcome_total`,
      help: 'Bounded in-run LLM tool-observation outcomes (#414)',
      labelNames: ['tool_name', 'platform', 'outcome'],
      registers: [this.registry],
    });

    this.llmToolPolicyDenied = new Counter({
      name: `${this.prefix}_llm_tool_policy_denied_total`,
      help: 'LLM tool calls blocked by capability, argument, or identity policy',
      labelNames: ['tool', 'platform', 'reason'],
      registers: [this.registry],
    });

    this.llmInjectionBlocked = new Counter({
      name: `${this.prefix}_llm_injection_blocked_total`,
      help: 'Prompt-injection payloads neutralized before reaching model context (#629)',
      labelNames: ['source', 'platform'],
      registers: [this.registry],
    });

    this.clarificationOutcomes = new Counter({
      name: `${this.prefix}_clarification_outcomes_total`,
      help: 'Bounded clarification state-machine outcomes (#401)',
      labelNames: ['outcome'],
      registers: [this.registry],
    });

    this.llmAdmissionRejected = new Counter({
      name: `${this.prefix}_llm_admission_rejected_total`,
      help: 'LLM calls shed before provider invocation (bounded admission #389)',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.llmAdmissionWait = new Histogram({
      name: `${this.prefix}_llm_admission_wait_seconds`,
      help: 'Time spent waiting for local admission before LLM execution starts',
      buckets: [0.005, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 8],
      registers: [this.registry],
    });

    this.llmAdmissionQueueDepth = new Gauge({
      name: `${this.prefix}_llm_admission_queue_depth`,
      help: 'Current number of LLM calls waiting for a local admission slot (#389)',
      registers: [this.registry],
    });

    this.llmProviderAttempts = new Counter({
      name: `${this.prefix}_llm_provider_attempts_total`,
      help: 'LLM provider attempts made by the failover adapter',
      labelNames: ['provider', 'feature'],
      registers: [this.registry],
    });

    this.llmProviderCircuitEvents = new Counter({
      name: `${this.prefix}_llm_provider_circuit_events_total`,
      help: 'LLM provider circuit state changes and cooldown skips',
      labelNames: ['provider', 'action', 'reason'],
      registers: [this.registry],
    });

    this.llmProvidersExhausted = new Counter({
      name: `${this.prefix}_llm_providers_exhausted_total`,
      help: 'LLM requests for which every configured provider failed',
      labelNames: ['provider_count', 'feature'],
      registers: [this.registry],
    });

    this.llmDegradedMode = new Counter({
      name: `${this.prefix}_llm_degraded_mode_total`,
      help: 'Fallback and degraded responses with bounded operational context',
      labelNames: ['platform', 'feature', 'failure_class', 'action'],
      registers: [this.registry],
    });

    this.writeToolBudgetDenied = new Counter({
      name: `${this.prefix}_write_tool_budget_denied_total`,
      help: 'Mutating LLM tool calls denied by the per-user write-tool budget (#626)',
      labelNames: ['tool', 'platform', 'reason'],
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

    this.webActivityWebhookReceived = new Counter({
      name: `${this.prefix}_web_activity_webhook_received_total`,
      help: 'WISPACE web-activity webhook deliveries received',
      registers: [this.registry],
    });

    this.scheduledSendSuppressed = new Counter({
      name: `${this.prefix}_scheduled_send_suppressed_total`,
      help: 'Scheduled sends suppressed because the learner is dormant on WISPACE web',
      labelNames: ['feature'],
      registers: [this.registry],
    });

    this.dmDeliveryFailures = new Counter({
      name: `${this.prefix}_dm_delivery_failures_total`,
      help: 'Direct-message delivery failures (privacy-blocked DMs, Discord API errors)',
      labelNames: ['reason'],
      registers: [this.registry],
    });

    this.outboundActionNeutralized = new Counter({
      name: `${this.prefix}_outbound_action_neutralized_total`,
      help: 'Outbound platform-action tokens neutralized before delivery',
      labelNames: ['kind'],
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

    this.chatIdentityStaleDetected = new Counter({
      name: `${this.prefix}_chat_identity_stale_detected_total`,
      help: 'Stale identity detected during chat flush revalidation (#397)',
      labelNames: ['platform', 'outcome'],
      registers: [this.registry],
    });

    this.chatRevalidationSkip = new Counter({
      name: `${this.prefix}_chat_revalidation_skip_total`,
      help: 'Fresh-mapping revalidation skipped due to infra failure (#397)',
      labelNames: ['reason'],
      registers: [this.registry],
    });
    this.chatFlushRecovery = new Counter({
      name: `${this.prefix}_chat_flush_recovery_total`,
      help: 'Distributed chat flush recovery outcomes',
      labelNames: ['platform', 'outcome'],
      registers: [this.registry],
    });
    this.platformLinkTransitions = new Counter({
      name: `${this.prefix}_platform_link_transition_total`,
      help: 'Canonical platform-link ownership transitions',
      labelNames: ['platform', 'outcome'],
      registers: [this.registry],
    });
    this.dataQualityCheckStatus = new Gauge({
      name: `${this.prefix}_data_quality_check_status`,
      help: 'Latest scheduled data-quality check status (1=pass, 0=fail)',
      labelNames: ['check'],
      registers: [this.registry],
    });
    this.dataQualityRuns = new Counter({
      name: `${this.prefix}_data_quality_runs_total`,
      help: 'Scheduled data-quality run outcomes',
      labelNames: ['outcome'],
      registers: [this.registry],
    });
    this.dataQualityFailures = new Counter({
      name: `${this.prefix}_data_quality_check_failures_total`,
      help: 'Data-quality check failures',
      labelNames: ['check'],
      registers: [this.registry],
    });
    this.dbCircuitBreakerState = new Gauge({
      name: `${this.prefix}_db_circuit_breaker_state`,
      help: 'Database circuit breaker state (0=closed, 1=half-open, 2=open)',
      registers: [this.registry],
    });
    this.dbCircuitBreakerFailures = new Counter({
      name: `${this.prefix}_db_circuit_breaker_failures_total`,
      help: 'Database circuit breaker failure events',
      registers: [this.registry],
    });
    this.llmClassifierVerdict = new Counter({
      name: `${this.prefix}_llm_classifier_verdict_total`,
      help: 'LLM input-classifier verdicts by label and rollout mode (#649)',
      labelNames: ['label', 'mode', 'platform'],
      registers: [this.registry],
    });
    this.outboundRateLimitDecisions = new Counter({
      name: `${this.prefix}_outbound_rate_limit_decisions_total`,
      help: 'Outbound learner-message rate-limit decisions',
      labelNames: ['platform', 'outcome'],
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

  /** A mutating tool call was denied by the per-user write-tool budget (#626). */
  incWriteToolBudgetDenied(
    tool: string,
    platform: string,
    reason: 'daily' | 'per_message',
  ): void {
    this.writeToolBudgetDenied.inc({ tool, platform, reason });
  }

  incQuotaDenied(reason: string): void {
    this.quotaDenied.inc({ reason });
  }

  incReminderDispatch(status: string): void {
    this.reminderDispatch.inc({ status });
  }

  /** WISPACE web-activity webhook received (messenger only). */
  incWebActivityWebhookReceived(): void {
    this.webActivityWebhookReceived.inc();
  }

  /** A scheduled send was skipped for a web-inactive learner (count defaults to 1). */
  incScheduledSendSuppressed(feature: 'report' | 'reminder', count = 1): void {
    this.scheduledSendSuppressed.inc({ feature }, count);
  }

  /** DM delivery failure (e.g. user privacy settings block DMs) — ops signal. */
  incDmDeliveryFailure(reason: string): void {
    this.dmDeliveryFailures.inc({ reason });
  }

  /** Outbound action token neutralized before provider delivery (#633). */
  incOutboundActionNeutralized(
    kind: 'everyone' | 'here' | 'role' | 'user',
    count = 1,
  ): void {
    const boundedCount = Math.max(0, Math.floor(count));
    if (boundedCount > 0) {
      this.outboundActionNeutralized.inc({ kind }, boundedCount);
    }
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

  incObservationOutcome(
    toolName: string,
    platform: string,
    outcome: string,
  ): void {
    this.llmObservationOutcome.inc({ tool_name: toolName, platform, outcome });
  }

  incLlmToolPolicyDenied(tool: string, platform: string, reason: string): void {
    this.llmToolPolicyDenied.inc({ tool, platform, reason });
  }

  /** #629 — a neutralized prompt-injection payload; `source` ∈ user_input | tool_result | history. */
  incLlmInjectionBlocked(source: string, platform: string): void {
    this.llmInjectionBlocked.inc({ source, platform });
  }

  /** #649 — an LLM input-classifier verdict. `label` ∈ SAFE|INJECTION|DISCLOSURE_PROBE or an unavailable reason. */
  incClassifierVerdict(label: string, mode: string, platform: string): void {
    this.llmClassifierVerdict.inc({ label, mode, platform });
  }

  incOutboundRateLimitDecision(platform: string, outcome: string): void {
    this.outboundRateLimitDecisions.inc({ platform, outcome });
  }

  incClarificationOutcome(outcome: string): void {
    this.clarificationOutcomes.inc({ outcome });
  }

  /** Bounded-admission rejection reason — queue_full | wait_timeout | global_saturated | redis_unavailable (#389). */
  incLlmAdmissionRejected(reason: string): void {
    this.llmAdmissionRejected.inc({ reason });
  }

  /** How long an admitted call waited for a local slot before executing (#389). */
  observeLlmAdmissionWait(seconds: number): void {
    this.llmAdmissionWait.observe(seconds);
  }

  /** Current local admission queue depth — saturation signal (#389). */
  setLlmAdmissionQueueDepth(depth: number): void {
    this.llmAdmissionQueueDepth.set(depth);
  }

  incLlmProviderAttempt(provider: string, feature = 'unknown'): void {
    this.llmProviderAttempts.inc({ provider, feature });
  }

  incLlmProviderCircuitEvent(
    provider: string,
    action: string,
    reason = 'unknown',
  ): void {
    this.llmProviderCircuitEvents.inc({ provider, action, reason });
  }

  incLlmProvidersExhausted(providerCount: number, feature = 'unknown'): void {
    this.llmProvidersExhausted.inc({
      provider_count: String(Math.max(0, Math.floor(providerCount))),
      feature,
    });
  }

  /**
   * Records a degraded response without accepting correlation/user data as
   * labels. The caller logs the correlation id separately after redaction.
   */
  incLlmDegradedMode(event: {
    platform: string;
    feature: string;
    failureClass: string;
    action: string;
    correlationId?: string;
  }): void {
    this.llmDegradedMode.inc({
      platform: event.platform,
      feature: event.feature,
      failure_class: event.failureClass,
      action: event.action,
    });
  }

  /** Structural AdmissionMetrics adapter for the shared llm-agent port (#389). */
  get llmAdmission(): {
    incrementCounter(name: string, labels?: Record<string, string>): void;
    observeWaitSeconds(seconds: number): void;
    observeQueueDepth(depth: number): void;
  } {
    return {
      incrementCounter: (_name, labels) =>
        this.incLlmAdmissionRejected(labels?.reason ?? 'unknown'),
      observeWaitSeconds: (seconds) => this.observeLlmAdmissionWait(seconds),
      observeQueueDepth: (depth) => this.setLlmAdmissionQueueDepth(depth),
    };
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

  setDbCircuitBreakerState(state: 0 | 1 | 2): void {
    this.dbCircuitBreakerState.set(state);
  }

  incDbCircuitBreakerFailures(): void {
    this.dbCircuitBreakerFailures.inc();
  }

  /** Stale identity detected during flush revalidation (#397). */
  incChatIdentityStaleDetected(platform: string, outcome: string): void {
    this.chatIdentityStaleDetected.inc({ platform, outcome });
  }

  /** Fresh-mapping revalidation skipped due to infra failure (#397). */
  incChatRevalidationSkip(reason: string): void {
    this.chatRevalidationSkip.inc({ reason });
  }

  /** Distributed chat flush recovery outcome (#406). */
  incChatFlushRecovery(platform: string, outcome: string): void {
    this.chatFlushRecovery.inc({ platform, outcome });
  }

  incPlatformLinkTransition(
    platform: string,
    outcome: string,
    count = 1,
  ): void {
    this.platformLinkTransitions.inc({ platform, outcome }, count);
  }

  setDataQualityCheckStatus(check: string, status: 'pass' | 'fail'): void {
    this.dataQualityCheckStatus.set({ check }, status === 'pass' ? 1 : 0);
  }

  incDataQualityRun(outcome: 'pass' | 'fail' | 'skipped'): void {
    this.dataQualityRuns.inc({ outcome });
  }

  incDataQualityFailure(check: string): void {
    this.dataQualityFailures.inc({ check });
  }

  registerDbCircuitBreaker(breaker: {
    opened?: boolean;
    halfOpen?: boolean;
    on(event: 'open', listener: () => void): unknown;
    on(event: 'halfOpen', listener: (resetTimeout: number) => void): unknown;
    on(event: 'close', listener: () => void): unknown;
    on(event: 'failure', listener: (error: Error) => void): unknown;
    on(event: 'timeout', listener: () => void): unknown;
  }): void {
    const currentState = breaker.opened ? 2 : breaker.halfOpen ? 1 : 0;
    this.dbCircuitBreakerState.set(currentState);
    this.dbCircuitBreakerFailures.inc(0);

    breaker.on('open', () => {
      this.dbCircuitBreakerState.set(2);
    });
    breaker.on('halfOpen', () => {
      this.dbCircuitBreakerState.set(1);
    });
    breaker.on('close', () => {
      this.dbCircuitBreakerState.set(0);
    });
    breaker.on('failure', () => {
      this.dbCircuitBreakerFailures.inc();
    });
    breaker.on('timeout', () => {
      this.dbCircuitBreakerFailures.inc();
    });
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
