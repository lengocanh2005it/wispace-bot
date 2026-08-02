import { ZaloWebhookDedupeService } from './zalo-webhook-dedupe.service';

describe('ZaloWebhookDedupeService', () => {
  let service: ZaloWebhookDedupeService;

  beforeEach(() => {
    service = new ZaloWebhookDedupeService();
  });

  afterEach(() => {
    service.onModuleDestroy();
  });

  it('returns false for the first occurrence of a message', async () => {
    expect(await service.isDuplicate('msg-1')).toBe(false);
  });

  it('returns true for a duplicate message within TTL', async () => {
    await service.isDuplicate('msg-1');
    expect(await service.isDuplicate('msg-1')).toBe(true);
  });

  it('returns false for different message ids', async () => {
    await service.isDuplicate('msg-1');
    expect(await service.isDuplicate('msg-2')).toBe(false);
  });

  it('returns false after TTL expires', async () => {
    // Manually insert with past expiry
    const seen = (service as unknown as { seen: Map<string, number> }).seen;
    seen.set('msg-expired', Date.now() - 1000);

    expect(await service.isDuplicate('msg-expired')).toBe(false);
  });

  it('cleans up expired entries', async () => {
    // Add a non-expired entry, then an expired one
    await service.isDuplicate('new-msg');
    const seen = (service as unknown as { seen: Map<string, number> }).seen;
    seen.set('old-msg', Date.now() - 100_000);

    const cleanup = (service as unknown as { cleanup(): void }).cleanup.bind(
      service,
    );
    cleanup();

    expect(seen.has('old-msg')).toBe(false);
    expect(seen.has('new-msg')).toBe(true);
  });
});
