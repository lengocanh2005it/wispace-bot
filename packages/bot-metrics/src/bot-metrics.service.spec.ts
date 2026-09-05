import { EventEmitter } from 'events';
import { BotMetricsService } from './bot-metrics.service';
import type { PlatformConnectivitySnapshot } from '@wispace/bot-common/health';

describe('BotMetricsService - Database Circuit Breaker Metrics', () => {
  it('exposes bounded platform connectivity state and transitions', async () => {
    const metrics = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });
    const previous: PlatformConnectivitySnapshot = {
      name: 'discord',
      status: 'starting',
      ready: false,
      reason: 'startup_pending',
      lastConnectedAt: null,
      lastVerifiedAt: null,
    };
    const current: PlatformConnectivitySnapshot = {
      ...previous,
      status: 'connected',
      ready: true,
      reason: 'connected',
    };
    metrics.setPlatformConnectivity(previous, current);
    const output = await metrics.getMetrics();
    expect(output).toContain(
      'test_platform_connectivity_ready{platform="discord"} 1',
    );
    expect(output).toContain(
      'test_platform_connectivity_state{platform="discord",state="connected"} 1',
    );
    expect(output).toContain(
      'test_platform_connectivity_transitions_total{platform="discord",from="starting",to="connected"} 1',
    );
  });
  it('exposes db_circuit_breaker_state and db_circuit_breaker_failures_total metrics', async () => {
    const metrics = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });
    const emitter = new EventEmitter() as unknown as EventEmitter & {
      opened?: boolean;
      halfOpen?: boolean;
    };
    emitter.opened = false;
    emitter.halfOpen = false;

    metrics.registerDbCircuitBreaker(emitter);

    let output = await metrics.getMetrics();
    expect(output).toContain('test_db_circuit_breaker_state 0');
    expect(output).toContain('test_db_circuit_breaker_failures_total 0');

    // Open circuit
    emitter.emit('open');
    output = await metrics.getMetrics();
    expect(output).toContain('test_db_circuit_breaker_state 2');

    // Half-open circuit
    emitter.emit('halfOpen');
    output = await metrics.getMetrics();
    expect(output).toContain('test_db_circuit_breaker_state 1');

    // Close circuit
    emitter.emit('close');
    output = await metrics.getMetrics();
    expect(output).toContain('test_db_circuit_breaker_state 0');

    // Failure event
    emitter.emit('failure', new Error('timeout'));
    emitter.emit('timeout');
    output = await metrics.getMetrics();
    expect(output).toContain('test_db_circuit_breaker_failures_total 2');
  });

  it('exposes bounded clarification lifecycle outcomes without user labels', async () => {
    const metrics = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });

    metrics.incClarificationOutcome('started_ambiguous');
    const output = await metrics.getMetrics();

    expect(output).toContain(
      'test_clarification_outcomes_total{outcome="started_ambiguous"} 1',
    );
    expect(output).not.toContain('external_user_id');
  });

  it('exposes outbound rate-limit decisions without learner labels', async () => {
    const metrics = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });

    metrics.incOutboundRateLimitDecision('discord', 'limited');
    const output = await metrics.getMetrics();

    expect(output).toContain(
      'test_outbound_rate_limit_decisions_total{platform="discord",outcome="limited"} 1',
    );
    expect(output).not.toContain('external_user_id');
  });

  it('exposes bounded tool-observation outcomes with tool and platform labels', async () => {
    const metrics = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });

    metrics.incObservationOutcome('get_user_goals', 'discord', 'truncated');
    const output = await metrics.getMetrics();

    expect(output).toContain(
      'test_llm_observation_outcome_total{tool_name="get_user_goals",platform="discord",outcome="truncated"} 1',
    );
    expect(output).not.toContain('external_user_id');
  });

  it('exposes chat flush recovery outcomes without user labels', async () => {
    const metrics = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });

    metrics.incChatFlushRecovery('messenger', 'retry');
    metrics.incChatFlushRecovery('messenger', 'abandoned');
    metrics.incChatFlushRecovery('messenger', 'fenced_stale');
    metrics.incChatFlushRecovery('messenger', 'durable_recovery');
    const output = await metrics.getMetrics();

    expect(output).toContain(
      'test_chat_flush_recovery_total{platform="messenger",outcome="retry"} 1',
    );
    expect(output).toContain(
      'test_chat_flush_recovery_total{platform="messenger",outcome="abandoned"} 1',
    );
    expect(output).not.toContain('external_user_id');
  });

  it('exposes bounded Redis consistency drift and reconciliation outcomes', async () => {
    const metrics = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });

    metrics.setRedisConsistencyDrift('burst', 2);
    metrics.incRedisConsistencyEvent('burst', 'detected', 2);
    metrics.incRedisConsistencyEvent('burst', 'repaired', 2);

    const output = await metrics.getMetrics();
    expect(output).toContain('test_redis_consistency_drift{datum="burst"} 2');
    expect(output).toContain(
      'test_redis_consistency_events_total{datum="burst",outcome="detected"} 2',
    );
    expect(output).not.toContain('external_user_id');
  });

  it('exposes outbound action neutralization counts without user labels', async () => {
    const metrics = new BotMetricsService({
      prefix: 'discord',
      collectDefaults: false,
    });

    metrics.incOutboundActionNeutralized('everyone', 2);
    metrics.incOutboundActionNeutralized('role');

    const output = await metrics.getMetrics();
    expect(output).toContain(
      'discord_outbound_action_neutralized_total{kind="everyone"} 2',
    );
    expect(output).toContain(
      'discord_outbound_action_neutralized_total{kind="role"} 1',
    );
    expect(output).not.toContain('external_user_id');
  });

  it('exposes web-activity webhook + scheduled-send-suppressed counters', async () => {
    const svc = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });
    svc.incWebActivityWebhookReceived();
    svc.incScheduledSendSuppressed('report');
    svc.incScheduledSendSuppressed('reminder');
    svc.incScheduledSendSuppressed('reminder');
    const out = await svc.getMetrics();
    expect(out).toContain('test_web_activity_webhook_received_total 1');
    expect(out).toContain(
      'test_scheduled_send_suppressed_total{feature="report"} 1',
    );
    expect(out).toContain(
      'test_scheduled_send_suppressed_total{feature="reminder"} 2',
    );
  });

  it('exposes provider failover telemetry with bounded labels', async () => {
    const svc = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });
    svc.incLlmProviderAttempt('openai', 'FREE_FORM_CHAT');
    svc.incLlmProviderCircuitEvent('openai', 'open', 'quota_exceeded');
    svc.incLlmProvidersExhausted(2, 'FREE_FORM_CHAT');

    const out = await svc.getMetrics();
    expect(out).toContain(
      'test_llm_provider_attempts_total{provider="openai",feature="FREE_FORM_CHAT"} 1',
    );
    expect(out).toContain(
      'test_llm_provider_circuit_events_total{provider="openai",action="open",reason="quota_exceeded"} 1',
    );
    expect(out).toContain(
      'test_llm_providers_exhausted_total{provider_count="2",feature="FREE_FORM_CHAT"} 1',
    );
  });

  it('exposes LLM usage recorder counters for missing/unpriced/insert-failed events (#549)', async () => {
    const svc = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });
    svc.incLlmMissingTokens('FREE_FORM_CHAT');
    svc.incLlmUnpricedModelTokens('gpt-5.4');
    svc.incLlmUsageInsertFailure('db_error');

    const out = await svc.getMetrics();
    expect(out).toContain(
      'test_llm_missing_tokens_total{feature="FREE_FORM_CHAT"} 1',
    );
    expect(out).toContain(
      'test_llm_unpriced_model_tokens_total{model="gpt-5.4"} 1',
    );
    expect(out).toContain(
      'test_llm_usage_insert_failures_total{reason="db_error"} 1',
    );
  });

  it('exposes Redis concurrency lifecycle outcomes through the shared admission port', async () => {
    const svc = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });
    const admission = svc.llmAdmission;

    admission.incrementCounter('llm_concurrency_acquired');
    admission.incrementCounter('llm_concurrency_rejected');
    admission.incrementCounter('llm_concurrency_stale_release');
    admission.incrementCounter('llm_concurrency_released');
    admission.incrementCounter('llm_concurrency_release_error');

    const out = await svc.getMetrics();
    expect(out).toContain(
      'test_llm_concurrency_events_total{outcome="acquired"} 1',
    );
    expect(out).toContain(
      'test_llm_concurrency_events_total{outcome="rejected"} 1',
    );
    expect(out).toContain(
      'test_llm_concurrency_events_total{outcome="stale_release"} 1',
    );
    expect(out).toContain(
      'test_llm_concurrency_events_total{outcome="released"} 1',
    );
    expect(out).toContain(
      'test_llm_concurrency_events_total{outcome="release_error"} 1',
    );
    expect(out).not.toContain(
      'test_llm_admission_rejected_total{reason="unknown"}',
    );
  });

  it('exposes the oldest admission waiter age as a drain-lag gauge', async () => {
    const svc = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });

    svc.setLlmAdmissionDrainLag(1.25);

    const out = await svc.getMetrics();
    expect(out).toContain(
      '# HELP test_llm_admission_drain_lag_seconds Age of the oldest queued LLM admission waiter',
    );
    expect(out).toContain('test_llm_admission_drain_lag_seconds 1.25');
  });

  it('records degraded responses with platform and bounded failure/action labels', async () => {
    const svc = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });

    svc.incLlmDegradedMode({
      platform: 'discord',
      feature: 'FREE_FORM_CHAT',
      failureClass: 'provider_exhausted',
      action: 'chat_fallback',
      correlationId: 'message-123',
    });

    const out = await svc.getMetrics();
    expect(out).toContain(
      'test_llm_degraded_mode_total{platform="discord",feature="FREE_FORM_CHAT",failure_class="provider_exhausted",action="chat_fallback"} 1',
    );
    expect(out).not.toContain('correlation_id');
    expect(out).not.toContain('external_user_id');
  });

  it('exposes data-quality status and run outcomes without high-cardinality labels', async () => {
    const svc = new BotMetricsService({
      prefix: 'test',
      collectDefaults: false,
    });

    svc.setDataQualityCheckStatus('null_spike', 'fail');
    svc.setDataQualityCheckStatus('future_timestamps', 'pass');
    svc.incDataQualityFailure('null_spike');
    svc.incDataQualityRun('fail');
    svc.incDataQualityRun('skipped');

    const out = await svc.getMetrics();
    expect(out).toContain(
      'test_data_quality_check_status{check="null_spike"} 0',
    );
    expect(out).toContain(
      'test_data_quality_check_status{check="future_timestamps"} 1',
    );
    expect(out).toContain(
      'test_data_quality_check_failures_total{check="null_spike"} 1',
    );
    expect(out).toContain('test_data_quality_runs_total{outcome="fail"} 1');
    expect(out).not.toContain('external_user_id');
  });
  it('exposes write_tool_budget_denied_total with tool/platform/reason labels (#626)', async () => {
    const metrics = new BotMetricsService({
      prefix: 'discord',
      collectDefaults: false,
    });
    metrics.incWriteToolBudgetDenied(
      'precreate_next_exercise',
      'discord',
      'daily',
    );
    metrics.incWriteToolBudgetDenied(
      'reschedule_study_session',
      'discord',
      'per_message',
    );
    const out = await metrics.getMetrics();
    expect(out).toContain(
      'discord_write_tool_budget_denied_total{tool="precreate_next_exercise",platform="discord",reason="daily"} 1',
    );
    expect(out).toContain(
      'discord_write_tool_budget_denied_total{tool="reschedule_study_session",platform="discord",reason="per_message"} 1',
    );
  });

  it('exposes llm_classifier_verdict_total with label/mode/platform', async () => {
    const svc = new BotMetricsService({
      prefix: 'messenger',
      collectDefaults: false,
    });
    svc.incClassifierVerdict('INJECTION', 'shadow', 'messenger');
    svc.incClassifierVerdict('SAFE', 'enforce', 'messenger');
    const out = await svc.getMetrics();
    expect(out).toContain(
      '_llm_classifier_verdict_total{label="INJECTION",mode="shadow",platform="messenger"} 1',
    );
    expect(out).toContain(
      '_llm_classifier_verdict_total{label="SAFE",mode="enforce",platform="messenger"} 1',
    );
  });
});
