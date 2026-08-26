import { readWebhookThrottleConfig } from './throttling';

describe('webhook throttling config', () => {
  it('reads positive values and keeps safe defaults for invalid values', () => {
    expect(
      readWebhookThrottleConfig(
        (key) =>
          ({
            WEBHOOK_RATE_LIMIT_PER_MINUTE: '45.9',
            WEBHOOK_RATE_LIMIT_TTL_MS: '30000',
          })[key],
      ),
    ).toEqual({ limit: 45, ttlMs: 30000 });

    expect(
      readWebhookThrottleConfig(
        (key) =>
          ({
            WEBHOOK_RATE_LIMIT_PER_MINUTE: '0',
            WEBHOOK_RATE_LIMIT_TTL_MS: 'nope',
          })[key],
      ),
    ).toEqual({ limit: 120, ttlMs: 60000 });
  });
});
