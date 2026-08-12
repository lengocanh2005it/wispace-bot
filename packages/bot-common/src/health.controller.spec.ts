import type { DataSource } from 'typeorm';
import { InternalApiKeyGuard } from './internal-api-key.guard';
import type { RedisClientPort } from './redis.client.port';
import { HealthController } from './health.controller';

describe('HealthController', () => {
  const build = (
    overrides: {
      dataSource?: Partial<DataSource>;
      redisClient?: Partial<RedisClientPort>;
    } = {},
  ) => {
    const query = jest.fn().mockResolvedValue([{ '?column?': 1 }]);
    const dataSource = {
      query,
      ...overrides.dataSource,
    } as unknown as DataSource;
    const redisClient = {
      isEnabled: jest.fn().mockReturnValue(false),
      isConfiguredEnabled: jest.fn().mockReturnValue(false),
      ping: jest.fn().mockResolvedValue('PONG'),
      ...overrides.redisClient,
    } as unknown as RedisClientPort;
    return {
      controller: new HealthController(dataSource, redisClient),
      query,
      redisClient,
    };
  };

  describe('liveness (public GET /health)', () => {
    it('always returns generic process health — no dependency details', () => {
      const { controller } = build();
      const result = controller.liveness();
      expect(result).toEqual({ status: 'ok' });
      // Generic payload: must not mention database/redis/orm/version/config.
      expect(JSON.stringify(result)).not.toMatch(
        /database|redis|orm|version|uptime|dependency/i,
      );
    });

    it('returns ok even when database and redis are down', () => {
      const { controller } = build({
        dataSource: {
          query: jest.fn().mockRejectedValue(new Error('connection refused')),
        },
        redisClient: {
          isEnabled: jest.fn().mockReturnValue(false),
          isConfiguredEnabled: jest.fn().mockReturnValue(true),
          ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        },
      });
      expect(controller.liveness()).toEqual({ status: 'ok' });
    });
  });

  describe('readiness (public GET /health/ready)', () => {
    it('returns ok when database is connected and redis disabled', async () => {
      const { controller, query } = build();
      expect(await controller.readiness()).toEqual({ status: 'ok' });
      expect(query).toHaveBeenCalledWith('SELECT 1');
    });

    it('throws 503 with generic status-only body when database is down', async () => {
      const query = jest
        .fn()
        .mockRejectedValue(new Error('connection refused'));
      const { controller } = build({ dataSource: { query } });

      const error = await controller.readiness().catch((e: unknown) => e);
      expect(error).toHaveProperty('status', 503);
      expect((error as { getResponse(): unknown }).getResponse()).toEqual({
        status: 'error',
      });
    });

    it('throws 503 with generic status-only body when redis is configured but unreachable', async () => {
      const { controller } = build({
        redisClient: {
          isEnabled: jest.fn().mockReturnValue(false),
          isConfiguredEnabled: jest.fn().mockReturnValue(true),
        },
      });

      const error = await controller.readiness().catch((e: unknown) => e);
      expect(error).toHaveProperty('status', 503);
      // No dependency detail in the 503 body.
      expect((error as { getResponse(): unknown }).getResponse()).toEqual({
        status: 'error',
      });
    });

    it('returns ok when database and redis are both healthy', async () => {
      const { controller } = build({
        redisClient: {
          isEnabled: jest.fn().mockReturnValue(true),
          isConfiguredEnabled: jest.fn().mockReturnValue(true),
          ping: jest.fn().mockResolvedValue('PONG'),
        },
      });
      expect(await controller.readiness()).toEqual({ status: 'ok' });
    });
  });

  describe('detail (internal GET /health/detail)', () => {
    it('is protected by InternalApiKeyGuard', () => {
      const detailDescriptor = Object.getOwnPropertyDescriptor(
        HealthController.prototype,
        'detail',
      );
      const guards = Reflect.getMetadata(
        '__guards__',
        detailDescriptor?.value,
      ) as unknown[] | undefined;
      expect(guards).toContain(InternalApiKeyGuard);
    });

    it('returns full dependency detail when healthy', async () => {
      const { controller } = build();
      expect(await controller.detail()).toEqual({
        status: 'ok',
        database: 'connected',
        redis: 'disabled',
      });
    });

    it('returns database disconnected detail when database is down', async () => {
      const query = jest
        .fn()
        .mockRejectedValue(new Error('connection refused'));
      const { controller } = build({ dataSource: { query } });
      expect(await controller.detail()).toEqual({
        status: 'error',
        database: 'disconnected',
        redis: 'disabled',
      });
    });

    it('returns redis error detail when configured but not connected at boot', async () => {
      const { controller } = build({
        redisClient: {
          isEnabled: jest.fn().mockReturnValue(false),
          isConfiguredEnabled: jest.fn().mockReturnValue(true),
        },
      });
      expect(await controller.detail()).toEqual({
        status: 'error',
        database: 'connected',
        redis: 'error',
      });
    });

    it('returns redis unreachable detail when ping fails', async () => {
      const { controller } = build({
        redisClient: {
          isEnabled: jest.fn().mockReturnValue(true),
          isConfiguredEnabled: jest.fn().mockReturnValue(true),
          ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
        },
      });
      expect(await controller.detail()).toEqual({
        status: 'error',
        database: 'connected',
        redis: 'unreachable',
      });
    });
  });
});
