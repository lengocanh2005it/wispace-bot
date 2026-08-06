import type { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { PlatformChatRateLimitService } from './platform-chat-rate-limit.service';

describe('PlatformChatRateLimitService', () => {
  const dailyUsageRepo = {} as Repository<unknown>;
  const idempotencyRepo = {} as Repository<unknown>;

  function buildConfig(
    values: Record<string, string | undefined>,
  ): ConfigService {
    return { get: (key: string) => values[key] } as unknown as ConfigService;
  }

  it('zalo mode: constructs with defaults when CHAT_* env missing', () => {
    const service = new PlatformChatRateLimitService(
      { platform: 'zalo' },
      buildConfig({}),
      dailyUsageRepo,
      idempotencyRepo,
    );
    expect(service.isEnabled()).toBe(false);
  });

  it('zalo mode: only exact "true" enables rate limit', () => {
    const lenient = new PlatformChatRateLimitService(
      { platform: 'zalo' },
      buildConfig({ CHAT_RATE_LIMIT_ENABLED: '1' }),
      dailyUsageRepo,
      idempotencyRepo,
    );
    expect(lenient.isEnabled()).toBe(false);

    const enabled = new PlatformChatRateLimitService(
      { platform: 'zalo' },
      buildConfig({ CHAT_RATE_LIMIT_ENABLED: 'true' }),
      dailyUsageRepo,
      idempotencyRepo,
    );
    expect(enabled.isEnabled()).toBe(true);
  });

  it('discord mode: throws on missing required env, accepts true/1/yes', () => {
    expect(
      () =>
        new PlatformChatRateLimitService(
          { platform: 'discord', requireEnv: true, lenientEnabledCheck: true },
          buildConfig({}),
          dailyUsageRepo,
          idempotencyRepo,
        ),
    ).toThrow('CHAT_FREE_FORM_DAILY_LIMIT must be set in .env');

    const service = new PlatformChatRateLimitService(
      { platform: 'discord', requireEnv: true, lenientEnabledCheck: true },
      buildConfig({
        CHAT_RATE_LIMIT_ENABLED: 'yes',
        CHAT_FREE_FORM_DAILY_LIMIT: '20',
        CHAT_BURST_PER_MINUTE: '5',
        CHAT_USAGE_TIMEZONE: 'Asia/Ho_Chi_Minh',
        CHAT_BURST_COUNT_REFUNDED: '1',
      }),
      dailyUsageRepo,
      idempotencyRepo,
    );
    expect(service.isEnabled()).toBe(true);
  });

  it('alias methods delegate to reserve/refund', async () => {
    const service = new PlatformChatRateLimitService(
      { platform: 'zalo' },
      buildConfig({}),
      dailyUsageRepo,
      idempotencyRepo,
    );

    const reserveSpy = jest
      .spyOn(service, 'reserve')
      .mockResolvedValue({ allowed: true } as never);
    await service.reserveFreeFormSlot('u1', { idempotencyKey: 'k1' });
    expect(reserveSpy).toHaveBeenCalledWith('u1', 'k1');

    const refundSpy = jest.spyOn(service, 'refund').mockResolvedValue();
    await service.refundFreeFormSlot('u1', '2026-08-06', 'k1');
    expect(refundSpy).toHaveBeenCalledWith('u1', '2026-08-06', 'k1');
  });
});
