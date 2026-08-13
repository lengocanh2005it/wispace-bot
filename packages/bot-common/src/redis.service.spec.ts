import IORedis from 'ioredis';
import { RedisService } from './redis.service';

jest.mock('ioredis', () => ({
  __esModule: true,
  default: jest.fn().mockImplementation(() => ({
    ping: jest.fn().mockResolvedValue('PONG'),
    quit: jest.fn().mockResolvedValue('OK'),
  })),
}));

describe('RedisService', () => {
  it('passes certificate validation options to Redis TLS connections', async () => {
    const service = new RedisService({
      get: (key: string) =>
        ({
          REDIS_ENABLED: 'true',
          REDIS_TLS: 'true',
          REDIS_CA: 'trusted-ca',
        })[key],
    } as never);

    await service.onModuleInit();

    expect(IORedis).toHaveBeenCalledWith(
      expect.objectContaining({
        tls: { rejectUnauthorized: true, ca: 'trusted-ca' },
      }),
    );
  });

  it('rejects plaintext Redis outside an explicitly trusted private network', async () => {
    const service = new RedisService({
      get: (key: string) =>
        ({
          REDIS_ENABLED: 'true',
          REDIS_HOST: 'redis.example.com',
          REDIS_TLS: 'false',
        })[key],
    } as never);

    await service.onModuleInit();

    expect(service.isEnabled()).toBe(false);
    expect(IORedis).not.toHaveBeenCalledWith(
      expect.objectContaining({ host: 'redis.example.com' }),
    );
  });
});
