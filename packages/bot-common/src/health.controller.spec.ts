import type { DataSource } from 'typeorm';
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

  it('returns status ok when database is connected', async () => {
    const { controller, query } = build();
    const result = await controller.check();
    expect(result).toEqual({
      status: 'ok',
      database: 'connected',
      redis: 'disabled',
    });
    expect(query).toHaveBeenCalledWith('SELECT 1');
  });

  it('throws ServiceUnavailableException with generic error when database is down', async () => {
    const query = jest.fn().mockRejectedValue(new Error('connection refused'));
    const { controller } = build({ dataSource: { query } });

    const error = await controller.check().catch((e: unknown) => e);
    expect(error).toHaveProperty('status', 503);
    expect((error as { getResponse(): unknown }).getResponse()).toEqual({
      status: 'error',
    });
  });

  it('returns disabled when redis is disabled', async () => {
    const { controller } = build();
    expect(await controller.checkRedis()).toEqual({
      ok: true,
      redis: 'disabled',
    });
  });

  it('returns connected when redis pings PONG', async () => {
    const { controller } = build({
      redisClient: {
        isEnabled: jest.fn().mockReturnValue(true),
        isConfiguredEnabled: jest.fn().mockReturnValue(true),
        ping: jest.fn().mockResolvedValue('PONG'),
      },
    });
    expect(await controller.checkRedis()).toEqual({
      ok: true,
      redis: 'connected',
    });
  });

  it('throws ServiceUnavailableException when redis is configured but not connected at boot', async () => {
    const { controller } = build({
      redisClient: {
        isEnabled: jest.fn().mockReturnValue(false),
        isConfiguredEnabled: jest.fn().mockReturnValue(true),
      },
    });

    await expect(controller.check()).rejects.toHaveProperty('status', 503);
    const error = await controller.checkRedis().catch((e: unknown) => e);
    expect((error as { getResponse(): unknown }).getResponse()).toEqual({
      ok: false,
      redis: 'error',
    });
  });

  it('throws ServiceUnavailableException with detail when redis is unreachable', async () => {
    const { controller } = build({
      redisClient: {
        isEnabled: jest.fn().mockReturnValue(true),
        isConfiguredEnabled: jest.fn().mockReturnValue(true),
        ping: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')),
      },
    });

    const error = await controller.checkRedis().catch((e: unknown) => e);
    expect((error as { getResponse(): unknown }).getResponse()).toEqual({
      ok: false,
      redis: 'unreachable',
    });
  });
});
