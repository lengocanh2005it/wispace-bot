import type { InboundRetryConfig } from './platform-webhook-inbound-event.service';
import {
  InlineWebhookInboundDispatcher,
  PlatformWebhookInboundEventService,
} from './platform-webhook-inbound-event.service';

function buildEventService() {
  return {
    claim: jest
      .fn<Promise<string | null>, [number]>()
      .mockResolvedValue('lease-1'),
    markCompleted: jest.fn().mockResolvedValue(true),
    markFailed: jest.fn().mockResolvedValue(true),
    markProcessingAbandoned: jest.fn().mockResolvedValue(true),
  } as unknown as PlatformWebhookInboundEventService;
}

function buildOptions(
  overrides: Partial<{
    processEvent: (rawPayload: object) => Promise<void>;
    retryConfig: InboundRetryConfig;
    concurrency: number;
  }> = {},
) {
  return {
    processEvent: jest.fn().mockResolvedValue(undefined),
    retryConfig: { maxRetries: 5, baseRetryMs: 60_000, capRetryMs: 480_000 },
    ...overrides,
  };
}

function buildDispatcher(
  eventService: PlatformWebhookInboundEventService = buildEventService(),
  opts: Parameters<typeof buildOptions>[0] = {},
) {
  const options = buildOptions(opts);
  return {
    dispatcher: new InlineWebhookInboundDispatcher(
      eventService,
      'messenger',
      options,
    ),
    eventService,
    options,
  };
}

const meta = {
  ingestedAt: new Date(),
  eventId: 'mid-test',
  externalUserId: 'psid-1',
};

describe('InlineWebhookInboundDispatcher', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  it('claims and processes the event on successful ingest', async () => {
    const { dispatcher, eventService, options } = buildDispatcher();

    dispatcher.tryInline(42, { text: 'hello' }, meta);

    // Run microtask queue
    await jest.advanceTimersByTimeAsync(0);

    expect(eventService.claim).toHaveBeenCalledWith(42);
    expect(options.processEvent).toHaveBeenCalledWith({ text: 'hello' });
    expect(eventService.markCompleted).toHaveBeenCalledWith(42, 'lease-1');
  });

  it('marks failed with backoff when processEvent throws', async () => {
    const { dispatcher, eventService } = buildDispatcher(undefined, {
      processEvent: jest.fn().mockRejectedValue(new Error('WISPACE down')),
    });

    dispatcher.tryInline(10, { text: 'x' }, meta);
    await jest.advanceTimersByTimeAsync(0);

    expect(eventService.markFailed).toHaveBeenCalledWith(
      10,
      'lease-1',
      'WISPACE down',
      expect.objectContaining({ maxRetries: 5 }),
    );
    expect(eventService.markCompleted).not.toHaveBeenCalled();
  });

  it('does not process when claim returns null (cron already claimed)', async () => {
    const eventService = buildEventService();
    (eventService.claim as jest.Mock).mockResolvedValue(null);
    const { dispatcher, options } = buildDispatcher(eventService);

    dispatcher.tryInline(99, { text: 'x' }, meta);
    await jest.advanceTimersByTimeAsync(0);

    expect(options.processEvent).not.toHaveBeenCalled();
  });

  it('fire-and-forget: errors in processEvent do not throw', async () => {
    const { dispatcher } = buildDispatcher(undefined, {
      processEvent: jest.fn().mockRejectedValue(new Error('boom')),
    });

    // Should not throw even though processEvent rejects
    expect(() => {
      dispatcher.tryInline(1, { text: 'x' }, meta);
    }).not.toThrow();
    await jest.advanceTimersByTimeAsync(0);
  });

  it('concurrency limiter blocks when at capacity', async () => {
    const { dispatcher, eventService, options } = buildDispatcher(undefined, {
      concurrency: 2,
      processEvent: jest
        .fn()
        .mockImplementation(
          () => new Promise<void>((resolve) => setTimeout(resolve, 100)),
        ),
    });

    // Start 3 inline attempts — first 2 should run, 3rd queued
    dispatcher.tryInline(1, { text: 'a' }, meta);
    dispatcher.tryInline(2, { text: 'b' }, meta);
    dispatcher.tryInline(3, { text: 'c' }, meta);

    await jest.advanceTimersByTimeAsync(0);

    // Only 2 claims should have happened (concurrency=2)
    expect(eventService.claim).toHaveBeenCalledTimes(2);
    expect(options.processEvent).toHaveBeenCalledTimes(2);

    // Let first one finish
    await jest.advanceTimersByTime(100);
    await jest.advanceTimersByTimeAsync(0);

    // Third should now claim
    expect(eventService.claim).toHaveBeenCalledTimes(3);
    expect(options.processEvent).toHaveBeenCalledTimes(3);
  });

  it('race: claim returns null for duplicate row (CAS prevents double-process)', async () => {
    const eventService = buildEventService();
    (eventService.claim as jest.Mock)
      .mockResolvedValueOnce('lease-1')
      .mockResolvedValueOnce(null); // second call (same row) loses
    const { dispatcher, options } = buildDispatcher(eventService);

    // Both should fire — first claims, second loses
    dispatcher.tryInline(1, { text: 'a' }, meta);
    dispatcher.tryInline(1, { text: 'a' }, meta);
    await jest.advanceTimersByTimeAsync(0);

    expect(eventService.claim).toHaveBeenCalledTimes(2);
    expect(options.processEvent).toHaveBeenCalledTimes(1);
  });
});
