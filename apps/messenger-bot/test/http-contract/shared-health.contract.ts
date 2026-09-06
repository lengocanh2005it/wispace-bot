import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  HealthController,
  OPS_HEALTH_SERVICE,
} from '@wispace/bot-common/health';
import { REDIS_CLIENT } from '@wispace/bot-common/redis';
import { DataSource } from 'typeorm';
import { createContractApp } from './helpers';

function mockDataSource(connected = true) {
  return {
    query: connected
      ? jest.fn().mockResolvedValue([{ in_recovery: false }])
      : jest.fn().mockRejectedValue(new Error('connection refused')),
    isInitialized: true,
  } as unknown as DataSource;
}

function mockRedisClient(
  opts: {
    configured?: boolean;
    enabled?: boolean;
    ping?: string;
  } = {},
) {
  return {
    isConfiguredEnabled: jest.fn().mockReturnValue(opts.configured ?? false),
    isEnabled: jest.fn().mockReturnValue(opts.enabled ?? false),
    ping: jest.fn().mockResolvedValue(opts.ping ?? 'PONG'),
  };
}

describe('Health endpoints (HTTP contract)', () => {
  let app: INestApplication<App>;

  async function bootApp(
    deps: {
      dsConnected?: boolean;
      redisConfigured?: boolean;
      redisEnabled?: boolean;
      redisPing?: string;
      opsHealthReady?: boolean;
    } = {},
  ) {
    const ds = mockDataSource(deps.dsConnected);
    const redis = mockRedisClient({
      configured: deps.redisConfigured,
      enabled: deps.redisEnabled,
      ping: deps.redisPing,
    });

    const providers: Array<{ provide: unknown; useValue: unknown }> = [
      { provide: DataSource, useValue: ds },
      { provide: REDIS_CLIENT, useValue: redis },
    ];

    if (deps.opsHealthReady !== undefined) {
      providers.push({
        provide: OPS_HEALTH_SERVICE,
        useValue: {
          isApplicationReady: jest.fn().mockResolvedValue({
            ready: deps.opsHealthReady,
            status: deps.opsHealthReady ? 'ok' : 'error',
            reason: deps.opsHealthReady ? undefined : 'test-reason',
          }),
          collectSnapshot: jest.fn().mockResolvedValue({
            status: deps.opsHealthReady ? 'ok' : 'error',
            database: 'connected',
            redis: 'disabled',
          }),
        },
      });
    }

    app = await createContractApp({
      controllers: [HealthController],
      providers,
      skipPrefix: true,
    });
    return ds;
  }

  afterEach(async () => {
    await app?.close();
  });

  describe('GET /health (liveness)', () => {
    it('returns 200 with generic status — never exposes details', async () => {
      await bootApp({
        dsConnected: false,
        redisEnabled: true,
        redisPing: 'timeout',
      });

      await request(app.getHttpServer())
        .get('/health')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({ status: 'ok' });
        });
    });
  });

  describe('GET /health/ready (readiness)', () => {
    it('returns 200 when DB is connected and Redis is not configured', async () => {
      await bootApp({ dsConnected: true, redisConfigured: false });

      await request(app.getHttpServer())
        .get('/health/ready')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toEqual({ status: 'ok' });
        });
    });

    it('returns 200 when DB connected and Redis connected', async () => {
      await bootApp({
        dsConnected: true,
        redisConfigured: true,
        redisEnabled: true,
        redisPing: 'PONG',
      });

      await request(app.getHttpServer()).get('/health/ready').expect(200);
    });

    it('returns 503 with status-only body when DB is down', async () => {
      const ds = await bootApp({ dsConnected: true, redisConfigured: false });
      (ds.query as jest.Mock).mockRejectedValue(
        new Error('connection refused'),
      );

      await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503)
        .expect(({ body }) => {
          expect(body).toEqual({ status: 'error' });
          expect(body).not.toHaveProperty('database');
          expect(body).not.toHaveProperty('redis');
        });
    });

    it('returns 503 when Redis is configured but unreachable', async () => {
      await bootApp({
        dsConnected: true,
        redisConfigured: true,
        redisEnabled: false,
      });

      await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503)
        .expect(({ body }) => {
          expect(body).toEqual({ status: 'error' });
        });
    });

    it('delegates to OpsHealthService when wired', async () => {
      await bootApp({ opsHealthReady: true });

      await request(app.getHttpServer()).get('/health/ready').expect(200);
    });

    it('returns 503 when OpsHealthService reports not ready', async () => {
      await bootApp({ opsHealthReady: false });

      await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503)
        .expect(({ body }) => {
          expect(body).toEqual({ status: 'error' });
        });
    });
  });

  describe('GET /health/detail (internal)', () => {
    it('returns full detail when DB and Redis are healthy', async () => {
      await bootApp({
        dsConnected: true,
        redisConfigured: true,
        redisEnabled: true,
        redisPing: 'PONG',
      });

      await request(app.getHttpServer())
        .get('/health/detail')
        .expect(200)
        .expect(({ body }) => {
          expect(body).toMatchObject({
            status: 'ok',
            database: 'connected',
            redis: 'connected',
          });
        });
    });

    it('reports disconnected DB in detail without leaking to readiness', async () => {
      await bootApp({ dsConnected: false, redisConfigured: false });

      const detailRes = await request(app.getHttpServer())
        .get('/health/detail')
        .expect(200);

      expect(detailRes.body).toMatchObject({
        status: 'error',
        database: 'disconnected',
      });

      // Readiness stays generic — no DB detail leaked
      await request(app.getHttpServer())
        .get('/health/ready')
        .expect(503)
        .expect(({ body }) => {
          expect(body).not.toHaveProperty('database');
        });
    });
  });
});
