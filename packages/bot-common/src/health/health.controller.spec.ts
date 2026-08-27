import type { DataSource } from 'typeorm';
import { InternalApiKeyGuard } from '../guard/internal-api-key.guard';
import type { RedisClientPort } from '../redis/redis.client.port';
import {
  HealthController,
  type OpsHealthServicePort,
} from './health.controller';

describe('HealthController', () => {
  const build = (
    overrides: {
      dataSource?: Partial<DataSource>;
      redisClient?: Partial<RedisClientPort>;
      opsHealthService?: Partial<OpsHealthServicePort>;
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
    const opsHealthService = overrides.opsHealthService as
      | OpsHealthServicePort
      | undefined;
    return {
      controller: new HealthController(
        dataSource,
        redisClient,
        opsHealthService,
      ),
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

    it('delegates to opsHealthService when provided and returns ok when ready', async () => {
      const opsHealthService: OpsHealthServicePort = {
        isApplicationReady: jest
          .fn()
          .mockResolvedValue({ ready: true, status: 'ok' }),
        collectSnapshot: jest.fn(),
      };
      const { controller } = build({ opsHealthService });

      expect(await controller.readiness()).toEqual({ status: 'ok' });
      expect(opsHealthService.isApplicationReady).toHaveBeenCalled();
    });

    it('throws 503 when opsHealthService reports not ready without leaking reason publicly', async () => {
      const opsHealthService: OpsHealthServicePort = {
        isApplicationReady: jest.fn().mockResolvedValue({
          ready: false,
          status: 'error',
          reason: 'webhook_inbound_stuck_age_1200s',
        }),
        collectSnapshot: jest.fn(),
      };
      const { controller } = build({ opsHealthService });

      const error = await controller.readiness().catch((e: unknown) => e);
      expect(error).toHaveProperty('status', 503);
      expect((error as { getResponse(): unknown }).getResponse()).toEqual({
        status: 'error',
      });
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

    it('returns full snapshot from opsHealthService when provided', async () => {
      const snapshot = {
        status: 'ok',
        infrastructure: { database: 'connected', redis: 'connected' },
        queues: { webhookInbound: { pendingCount: 0 } },
      };
      const opsHealthService: OpsHealthServicePort = {
        isApplicationReady: jest.fn(),
        collectSnapshot: jest.fn().mockResolvedValue(snapshot),
      };
      const { controller } = build({ opsHealthService });

      expect(await controller.detail()).toEqual(snapshot);
      expect(opsHealthService.collectSnapshot).toHaveBeenCalled();
    });
  });
});
