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
});
