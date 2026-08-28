import { EventEmitter } from 'events';
import { BotMetricsService } from './bot-metrics.service';

describe('BotMetricsService - Database Circuit Breaker Metrics', () => {
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
});
