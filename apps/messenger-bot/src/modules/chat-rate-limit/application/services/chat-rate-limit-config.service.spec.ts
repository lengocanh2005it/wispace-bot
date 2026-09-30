import type { ConfigService } from '@nestjs/config';
import { ChatRateLimitConfigService } from './chat-rate-limit-config.service';

const buildService = (value?: string): ChatRateLimitConfigService =>
  new ChatRateLimitConfigService({
    get: (key: string) => (key === 'CHAT_BURST_STORE' ? value : undefined),
  } as unknown as ConfigService);

describe('ChatRateLimitConfigService.getBurstStore', () => {
  it('defaults to postgres, the correctness floor (ADR-0007)', () => {
    expect(buildService(undefined).getBurstStore()).toBe('postgres');
    expect(buildService('  ').getBurstStore()).toBe('postgres');
  });

  it('selects the Redis HA tier when asked', () => {
    expect(buildService('redis').getBurstStore()).toBe('redis');
    expect(buildService('  REDIS ').getBurstStore()).toBe('redis');
  });

  // #1288 retired the memory store. A deployment still carrying the old value
  // must land on Postgres rather than fail the bot, and must not silently get
  // a weaker guarantee either.
  it('falls back to postgres for the retired memory value (#1288)', () => {
    expect(buildService('memory').getBurstStore()).toBe('postgres');
  });

  // The fallback above is silent, which is why production needs a second
  // signal: an unset value is a legitimate default, an unsupported one is a
  // misconfiguration and must be distinguishable from it.
  it.each(['memory', 'MEMORY', 'sqlite', 'redis-sentinel'])(
    'reports %s as an unsupported configured store (#1288)',
    (value) => {
      expect(buildService(value).isBurstStoreValueUnsupported()).toBe(true);
    },
  );

  it.each([undefined, '', '   ', 'redis', 'postgres', ' POSTGRES '])(
    'does not report %p as unsupported (#1288)',
    (value) => {
      expect(buildService(value).isBurstStoreValueUnsupported()).toBe(false);
    },
  );
});
