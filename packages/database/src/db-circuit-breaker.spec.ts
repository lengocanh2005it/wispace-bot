import { DataSource } from 'typeorm';
import { BotMetricsService } from '@wispace/bot-metrics';
import {
  readDbCircuitBreakerOptions,
  attachDbCircuitBreaker,
  getDbCircuitBreaker,
  DbCircuitBreakerService,
} from './db-circuit-breaker';

describe('Database Circuit Breaker', () => {
  describe('readDbCircuitBreakerOptions', () => {
    it('returns defaults when env vars are unset', () => {
      const opts = readDbCircuitBreakerOptions({});
      expect(opts.enabled).toBe(true);
      expect(opts.threshold).toBe(5);
      expect(opts.errorThresholdPercentage).toBe(50);
      expect(opts.resetTimeoutMs).toBe(30_000);
      expect(opts.timeoutMs).toBe(6_000);
    });

    it('respects custom env configuration', () => {
      const opts = readDbCircuitBreakerOptions({
        DB_CIRCUIT_BREAKER_ENABLED: 'false',
        DB_CIRCUIT_BREAKER_THRESHOLD: '3',
        DB_CIRCUIT_BREAKER_ERROR_THRESHOLD_PERCENTAGE: '80',
        DB_CIRCUIT_BREAKER_RESET_TIMEOUT_MS: '15000',
        DB_CIRCUIT_BREAKER_TIMEOUT_MS: '4000',
      });
      expect(opts.enabled).toBe(false);
      expect(opts.threshold).toBe(3);
      expect(opts.errorThresholdPercentage).toBe(80);
      expect(opts.resetTimeoutMs).toBe(15_000);
      expect(opts.timeoutMs).toBe(4_000);
    });

    it('computes timeoutMs from DB_POOL_CONNECTION_TIMEOUT_MS + 1000 by default', () => {
      const opts = readDbCircuitBreakerOptions({
        DB_POOL_CONNECTION_TIMEOUT_MS: '8000',
      });
      expect(opts.timeoutMs).toBe(9_000);
    });
  });

  describe('attachDbCircuitBreaker & lifecycle transitions', () => {
    function createMockDataSource() {
      const ds = new DataSource({
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'password',
        database: 'test',
      });
      return ds;
    }

    it('does not attach when disabled', () => {
      const ds = createMockDataSource();
      const breaker = attachDbCircuitBreaker(ds, { enabled: false });
      expect(breaker).toBeUndefined();
      expect(getDbCircuitBreaker(ds)).toBeUndefined();
    });

    it('attaches and allows successful connection acquisition', async () => {
      const ds = createMockDataSource();
      const mockConn = { query: jest.fn() };
      const mockRelease = jest.fn();
      ds.driver.obtainMasterConnection = jest
        .fn()
        .mockResolvedValue([mockConn, mockRelease]);

      const breaker = attachDbCircuitBreaker(ds, {
        threshold: 3,
        resetTimeoutMs: 1000,
      });
      expect(breaker).toBeDefined();
      expect(getDbCircuitBreaker(ds)).toBe(breaker);

      const result = await ds.driver.obtainMasterConnection();
      expect(result).toEqual([mockConn, mockRelease]);
      expect(breaker?.opened).toBe(false);
    });

    it('transitions CLOSED -> OPEN after consecutive failures and fails fast', async () => {
      const ds = createMockDataSource();
      let callCount = 0;
      ds.driver.obtainMasterConnection = jest
        .fn()
        .mockImplementation(async () => {
          callCount++;
          throw new Error('Connection timeout exceeded');
        });

      const breaker = attachDbCircuitBreaker(ds, {
        threshold: 3,
        resetTimeoutMs: 100,
        timeoutMs: 50,
      });
      expect(breaker).toBeDefined();

      // Trigger 3 failures to reach threshold
      for (let i = 0; i < 3; i++) {
        await expect(ds.driver.obtainMasterConnection()).rejects.toThrow();
      }

      expect(callCount).toBe(3);
      expect(breaker?.opened).toBe(true);

      // 4th and 5th calls must fail fast without incrementing underlying pool callCount
      await expect(ds.driver.obtainMasterConnection()).rejects.toThrow(/open/i);
      await expect(ds.driver.obtainMasterConnection()).rejects.toThrow(/open/i);
      expect(callCount).toBe(3);
    });

    it('transitions OPEN -> HALF-OPEN -> CLOSED upon successful probe', async () => {
      const ds = createMockDataSource();
      let shouldFail = true;
      const mockConn = { query: jest.fn() };
      const mockRelease = jest.fn();

      ds.driver.obtainMasterConnection = jest
        .fn()
        .mockImplementation(async () => {
          if (shouldFail) {
            throw new Error('Connection timeout exceeded');
          }
          return [mockConn, mockRelease];
        });

      const breaker = attachDbCircuitBreaker(ds, {
        threshold: 2,
        resetTimeoutMs: 50,
        timeoutMs: 50,
      });

      // Fail twice to open circuit
      for (let i = 0; i < 2; i++) {
        await expect(ds.driver.obtainMasterConnection()).rejects.toThrow();
      }
      expect(breaker?.opened).toBe(true);

      // Wait for resetTimeout to expire
      await new Promise((resolve) => setTimeout(resolve, 80));

      // Circuit is ready for half-open probe
      shouldFail = false;
      const result = await ds.driver.obtainMasterConnection();
      expect(result).toEqual([mockConn, mockRelease]);
      expect(breaker?.opened).toBe(false);
      expect(breaker?.halfOpen).toBe(false);
    });
  });

  describe('DbCircuitBreakerService', () => {
    it('registers breaker with BotMetricsService onModuleInit when both are present', () => {
      const ds = new DataSource({
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'password',
        database: 'test',
      });
      const breaker = attachDbCircuitBreaker(ds);
      const metrics = { registerDbCircuitBreaker: jest.fn() };

      const service = new DbCircuitBreakerService(
        ds,
        metrics as unknown as BotMetricsService,
      );
      service.onModuleInit();

      expect(metrics.registerDbCircuitBreaker).toHaveBeenCalledWith(breaker);
    });

    it('handles missing metrics service gracefully', () => {
      const ds = new DataSource({
        type: 'postgres',
        host: 'localhost',
        port: 5432,
        username: 'postgres',
        password: 'password',
        database: 'test',
      });
      attachDbCircuitBreaker(ds);

      const service = new DbCircuitBreakerService(ds, undefined);
      expect(() => service.onModuleInit()).not.toThrow();
    });
  });
});
