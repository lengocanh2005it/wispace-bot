import { CronHeartbeatRegistry } from './cron-heartbeat-registry';

describe('CronHeartbeatRegistry', () => {
  let registry: CronHeartbeatRegistry;

  beforeEach(() => {
    registry = new CronHeartbeatRegistry();
  });

  it('reports never_run when a cron is registered but has not ticked', () => {
    registry.registerCron('test-cron', 30_000);
    const crons = registry.getRegisteredCrons();

    expect(crons['test-cron']).toBeDefined();
    expect(crons['test-cron'].status).toBe('never_run');
    expect(crons['test-cron'].lastTickAt).toBeNull();
  });

  it('reports healthy immediately after a tick', () => {
    registry.recordTick('test-cron', 30_000, true);
    const crons = registry.getRegisteredCrons();

    expect(crons['test-cron'].status).toBe('healthy');
    expect(crons['test-cron'].lastTickAt).toBeDefined();
    expect(crons['test-cron'].lastSuccessAt).toBeDefined();
    expect(crons['test-cron'].lastError).toBeNull();
    expect(registry.hasStaleCrons()).toBe(false);
  });

  it('reports stale when elapsed time exceeds 2.5x expected interval', () => {
    jest.useFakeTimers();
    try {
      registry.recordTick('fast-cron', 10_000, true);
      expect(registry.hasStaleCrons()).toBe(false);

      // Advance time by 30 seconds (> 2.5 * 10s = 25s)
      jest.advanceTimersByTime(30_000);
      expect(registry.hasStaleCrons()).toBe(true);
      expect(registry.getRegisteredCrons()['fast-cron'].status).toBe('stale');
    } finally {
      jest.useRealTimers();
    }
  });

  it('records error message on failed tick without advancing lastSuccessAt', () => {
    registry.recordTick(
      'failing-cron',
      60_000,
      false,
      new Error('DB connection timeout'),
    );
    const crons = registry.getRegisteredCrons();

    expect(crons['failing-cron'].lastError).toBe('DB connection timeout');
    expect(crons['failing-cron'].lastSuccessAt).toBeNull();
  });
});
