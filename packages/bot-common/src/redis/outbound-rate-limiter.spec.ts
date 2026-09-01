import type Redis from 'ioredis';
import { OutboundRateLimiter } from './outbound-rate-limiter';

function buildService(
  values: Record<string, string | undefined> = {},
  redisOverrides: Partial<{
    isEnabled: () => boolean;
    isConfiguredEnabled: () => boolean;
    getNativeClient: () => Redis | null;
  }> = {},
): OutboundRateLimiter {
  const config = {
    get: (key: string) => values[key],
  };
  const redis = {
    isEnabled: () => false,
    isConfiguredEnabled: () => false,
    getNativeClient: () => null,
    ...redisOverrides,
  };
  return new OutboundRateLimiter(config as never, redis as never);
}

describe('OutboundRateLimiter', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('enforces an exact rolling cap in the local test store', async () => {
    const service = buildService({
      OUTBOUND_RATE_LIMIT_MAX_MESSAGES: '2',
      OUTBOUND_RATE_LIMIT_WINDOW_MS: '1000',
    });

    const first = await service.admit({
      platform: 'messenger',
      externalUserId: 'psid-1',
    });
    const second = await service.admit({
      platform: 'messenger',
      externalUserId: 'psid-1',
    });
    const third = await service.admit({
      platform: 'messenger',
      externalUserId: 'psid-1',
    });

    expect(first).toMatchObject({ allowed: true, outcome: 'allowed' });
    expect(second).toMatchObject({ allowed: true, outcome: 'allowed' });
    expect(third).toMatchObject({
      allowed: false,
      outcome: 'limited',
      reason: 'cap_exceeded',
    });
  });

  it('does not trip for one normal chat, reminder, and report burst', async () => {
    const service = buildService();

    const outcomes = await Promise.all([
      service.admit({
        platform: 'messenger',
        externalUserId: 'psid-1',
        userId: 42,
      }),
      service.admit({
        platform: 'discord',
        externalUserId: 'discord-1',
        userId: 42,
      }),
      service.admit({
        platform: 'zalo',
        externalUserId: 'zalo-1',
        userId: 42,
      }),
    ]);

    expect(outcomes.every((result) => result.allowed)).toBe(true);
  });

  it('contains a simulated retry storm at the configured cap', async () => {
    const service = buildService();

    const outcomes = await Promise.all(
      Array.from({ length: 31 }, () =>
        service.admit({
          platform: 'discord',
          externalUserId: 'discord-storm',
          userId: 42,
        }),
      ),
    );

    expect(outcomes.filter((result) => result.allowed)).toHaveLength(30);
    expect(outcomes.filter((result) => !result.allowed)).toHaveLength(1);
  });

  it('shares a canonical learner bucket across platforms', async () => {
    const service = buildService({
      OUTBOUND_RATE_LIMIT_MAX_MESSAGES: '2',
      OUTBOUND_RATE_LIMIT_WINDOW_MS: '1000',
    });

    await service.admit({
      platform: 'messenger',
      externalUserId: 'psid-1',
      userId: 42,
    });
    await service.admit({
      platform: 'discord',
      externalUserId: 'snowflake-1',
      userId: 42,
    });

    const result = await service.admit({
      platform: 'zalo',
      externalUserId: 'zalo-1',
      userId: 42,
    });

    expect(result.allowed).toBe(false);
  });

  it('admits a chunk batch atomically and leaves no partial reservation', async () => {
    const service = buildService({
      OUTBOUND_RATE_LIMIT_MAX_MESSAGES: '3',
      OUTBOUND_RATE_LIMIT_WINDOW_MS: '1000',
    });

    const first = await service.admit({
      platform: 'discord',
      externalUserId: 'discord-1',
      units: 2,
    });
    const denied = await service.admit({
      platform: 'discord',
      externalUserId: 'discord-1',
      units: 2,
    });
    const final = await service.admit({
      platform: 'discord',
      externalUserId: 'discord-1',
      units: 1,
    });

    expect(first.allowed).toBe(true);
    expect(denied).toMatchObject({ allowed: false, outcome: 'limited' });
    expect(final.allowed).toBe(true);
  });

  it('rejects a batch larger than the configured ceiling without sending a partial batch', async () => {
    const service = buildService({
      OUTBOUND_RATE_LIMIT_MAX_MESSAGES: '3',
      OUTBOUND_RATE_LIMIT_WINDOW_MS: '1000',
    });

    const oversized = await service.admit({
      platform: 'zalo',
      externalUserId: 'zalo-1',
      units: 4,
    });
    const normal = await service.admit({
      platform: 'zalo',
      externalUserId: 'zalo-1',
      units: 3,
    });

    expect(oversized).toMatchObject({
      allowed: false,
      outcome: 'limited',
      reason: 'batch_too_large',
    });
    expect(normal.allowed).toBe(true);
  });

  it('uses Redis atomically when available and hashes the bucket key', async () => {
    const evalMock = jest.fn().mockResolvedValue([1, 2]);
    const service = buildService(
      {
        OUTBOUND_RATE_LIMIT_MAX_MESSAGES: '30',
        OUTBOUND_RATE_LIMIT_WINDOW_MS: '600000',
      },
      {
        isEnabled: () => true,
        isConfiguredEnabled: () => true,
        getNativeClient: () => ({ eval: evalMock }) as never,
      },
    );

    const result = await service.admit({
      platform: 'messenger',
      externalUserId: 'psid-sensitive',
      userId: 42,
    });

    expect(result).toMatchObject({ allowed: true, outcome: 'allowed' });
    expect(evalMock).toHaveBeenCalledWith(
      expect.any(String),
      1,
      expect.stringMatching(/^outbound-rate:v1:[a-f0-9]{64}$/),
      '600000',
      '1',
      '30',
      expect.any(String),
    );
    expect(evalMock.mock.calls[0][2]).not.toContain('psid-sensitive');
  });

  it('fails open once when Redis is unavailable at runtime', async () => {
    const service = buildService(
      { OUTBOUND_RATE_LIMIT_MAX_MESSAGES: '2' },
      {
        isEnabled: () => true,
        isConfiguredEnabled: () => true,
        getNativeClient: () =>
          ({
            eval: jest.fn().mockRejectedValue(new Error('redis down')),
          }) as never,
      },
    );

    const result = await service.admit({
      platform: 'messenger',
      externalUserId: 'psid-1',
    });

    expect(result).toMatchObject({
      allowed: true,
      outcome: 'store_unavailable',
      reason: 'redis_unavailable',
    });
  });

  it('rejects enabled production startup without Redis', async () => {
    const service = buildService({
      NODE_ENV: 'production',
      OUTBOUND_RATE_LIMIT_ENABLED: 'true',
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      'Redis is required for outbound rate limiting in production',
    );
  });

  it('treats an explicitly disabled limiter as a no-op', async () => {
    const service = buildService({
      OUTBOUND_RATE_LIMIT_ENABLED: 'false',
      OUTBOUND_RATE_LIMIT_MAX_MESSAGES: '1',
    });

    const result = await service.admit({
      platform: 'messenger',
      externalUserId: 'psid-1',
    });

    expect(result).toMatchObject({ allowed: true, outcome: 'disabled' });
    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('fails startup on an invalid enabled flag', () => {
    expect(() =>
      buildService({ OUTBOUND_RATE_LIMIT_ENABLED: 'sometimes' }),
    ).toThrow('OUTBOUND_RATE_LIMIT_ENABLED must be a boolean');
  });
});
