import { readWebhookThrottleConfig, throttleTracker } from './throttling';

describe('throttleTracker', () => {
  it('returns X-Real-IP header when present', () => {
    const req = {
      headers: { 'x-real-ip': '203.0.113.42' },
      socket: { remoteAddress: '10.0.0.1' },
    } as any;
    expect(throttleTracker(req)).toBe('203.0.113.42');
  });

  it('falls back to socket.remoteAddress when header is missing', () => {
    const req = {
      headers: {},
      socket: { remoteAddress: '10.0.0.1' },
    } as any;
    expect(throttleTracker(req)).toBe('10.0.0.1');
  });

  it('ignores forged X-Forwarded-For header', () => {
    const req = {
      headers: {
        'x-real-ip': '198.51.100.7',
        'x-forwarded-for': '1.2.3.4, 10.0.0.1',
      },
      socket: { remoteAddress: '10.0.0.1' },
    } as any;
    expect(throttleTracker(req)).toBe('198.51.100.7');
  });

  it('returns undefined when both header and socket are absent (fail closed)', () => {
    const req = { headers: {}, socket: {} } as any;
    expect(throttleTracker(req)).toBeUndefined();
  });

  it('two different clients get independent keys', () => {
    const req1 = {
      headers: { 'x-real-ip': '1.1.1.1' },
      socket: { remoteAddress: '10.0.0.1' },
    } as any;
    const req2 = {
      headers: { 'x-real-ip': '2.2.2.2' },
      socket: { remoteAddress: '10.0.0.1' },
    } as any;
    expect(throttleTracker(req1)).not.toBe(throttleTracker(req2));
  });
});

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
