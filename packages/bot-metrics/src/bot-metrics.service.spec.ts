import { EventEmitter } from 'events';
import { BotMetricsService } from './bot-metrics.service';

describe('BotMetricsService - Database Circuit Breaker Metrics', () => {
  it('exposes db_circuitbreaker_state and db_circuitbreaker_failures_total metrics', async () => {
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
    expect(output).toContain('test_db_circuitbreaker_state 0');
    expect(output).toContain('test_db_circuitbreaker_failures_total 0');

    // Open circuit
    emitter.emit('open');
    output = await metrics.getMetrics();
    expect(output).toContain('test_db_circuitbreaker_state 2');

    // Half-open circuit
    emitter.emit('halfOpen');
    output = await metrics.getMetrics();
    expect(output).toContain('test_db_circuitbreaker_state 1');

    // Close circuit
    emitter.emit('close');
    output = await metrics.getMetrics();
    expect(output).toContain('test_db_circuitbreaker_state 0');

    // Failure event
    emitter.emit('failure', new Error('timeout'));
    emitter.emit('timeout');
    output = await metrics.getMetrics();
    expect(output).toContain('test_db_circuitbreaker_failures_total 2');
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
});
