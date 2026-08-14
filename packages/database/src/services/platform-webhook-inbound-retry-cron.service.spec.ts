import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import type { InboundEventRow } from './platform-webhook-inbound-event.service';
import {
  PlatformWebhookInboundRetryCronService,
  type WebhookInboundRetryCronOptions,
} from './platform-webhook-inbound-retry-cron.service';

function buildOptions(
  overrides: Partial<WebhookInboundRetryCronOptions> = {},
): WebhookInboundRetryCronOptions {
  return {
    lockId: 884_200_905,
    processEvent: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function buildService(options: WebhookInboundRetryCronOptions): {
  service: PlatformWebhookInboundRetryCronService;
  inboundEvents: {
    listDue: jest.Mock<
      Promise<InboundEventRow[]>,
      [{ limit: number; processingStuckMs: number }]
    >;
    claim: jest.Mock<Promise<boolean>, [number]>;
    markCompleted: jest.Mock;
    markFailed: jest.Mock;
    abandonStaleProcessing: jest.Mock;
    markProcessingAbandoned: jest.Mock;
  };
  configGet: jest.Mock<unknown, [string]>;
  pgLock: { withLock: jest.Mock };
} {
  const inboundEvents = {
    listDue: jest
      .fn<
        Promise<InboundEventRow[]>,
        [{ limit: number; processingStuckMs: number }]
      >()
      .mockResolvedValue([]),
    claim: jest.fn<Promise<boolean>, [number]>().mockResolvedValue(true),
    markCompleted: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
    abandonStaleProcessing: jest.fn().mockResolvedValue(true),
    markProcessingAbandoned: jest.fn().mockResolvedValue(true),
  };
  const configGet = jest.fn<unknown, [string]>(() => undefined);
  const configService = { get: configGet } as never as ConfigService;
  const pgLock = {
    withLock: jest
      .fn()
      .mockImplementation((_id: number, fn: () => Promise<void>) => fn()),
  };
  const service = new PlatformWebhookInboundRetryCronService(
    inboundEvents as never,
    configService,
    pgLock as never,
    options,
  );
  return { service, inboundEvents, configGet, pgLock };
}

function row(overrides: Partial<InboundEventRow> = {}): InboundEventRow {
  return {
    id: 1,
    platform: 'messenger',
    eventId: 'mid-1',
    externalUserId: 'psid-1',
    eventType: 'message',
    rawPayload: { message: { mid: 'mid-1' } },
    status: 'failed',
    retryCount: 0,
    nextRetryAt: new Date(),
    ...overrides,
  };
}

describe('PlatformWebhookInboundRetryCronService', () => {
  it('replays due events and marks them completed on success', async () => {
    const options = buildOptions();
    const { service, inboundEvents } = buildService(options);
    inboundEvents.listDue.mockResolvedValue([row()]);

    await service.handleRetry();

    expect(options.processEvent).toHaveBeenCalledWith({
      message: { mid: 'mid-1' },
    });
    expect(inboundEvents.markCompleted).toHaveBeenCalledWith(1);
    expect(inboundEvents.markFailed).not.toHaveBeenCalled();
  });

  it('records a bounded-backoff failure when processing throws', async () => {
    const options = buildOptions({
      processEvent: jest.fn().mockRejectedValue(new Error('WISPACE down')),
    });
    const { service, inboundEvents } = buildService(options);
    inboundEvents.listDue.mockResolvedValue([row({ retryCount: 1 })]);

    await service.handleRetry();

    expect(inboundEvents.markCompleted).not.toHaveBeenCalled();
    expect(inboundEvents.markFailed).toHaveBeenCalledWith(
      1,
      'WISPACE down',
      expect.objectContaining({ maxRetries: 5, baseRetryMs: 60_000 }),
    );
  });

  it('retry-then-success eventually completes the event', async () => {
    const options = buildOptions({
      processEvent: jest
        .fn()
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValueOnce(undefined),
    });
    const { service, inboundEvents } = buildService(options);
    inboundEvents.listDue
      .mockResolvedValueOnce([row({ id: 1, retryCount: 0 })])
      .mockResolvedValueOnce([row({ id: 1, retryCount: 1 })]);

    await service.handleRetry();
    expect(inboundEvents.markFailed).toHaveBeenCalledTimes(1);

    await service.handleRetry();
    expect(inboundEvents.markCompleted).toHaveBeenCalledWith(1);
  });

  it('#115: a failed send_text delivery stays retryable until a later attempt delivers exactly once', async () => {
    // Messenger's send_text is awaited: a Meta delivery failure propagates and
    // the event must NOT be completed; the retry cron replays it until one
    // attempt succeeds — exactly one successful delivery.
    const options = buildOptions({
      processEvent: jest
        .fn()
        .mockRejectedValueOnce(new Error('Meta Send API 500'))
        .mockResolvedValueOnce(undefined),
    });
    const { service, inboundEvents } = buildService(options);
    inboundEvents.listDue
      .mockResolvedValueOnce([row({ id: 1, retryCount: 0 })])
      .mockResolvedValueOnce([row({ id: 1, retryCount: 1 })]);

    await service.handleRetry();

    // Attempt 1 failed → the event is marked failed (retryable), never
    // completed, and no delivery was recorded as successful.
    expect(inboundEvents.markCompleted).not.toHaveBeenCalled();
    expect(inboundEvents.markFailed).toHaveBeenCalledTimes(1);
    expect(options.processEvent).toHaveBeenCalledTimes(1);

    await service.handleRetry();

    // Attempt 2 delivered successfully → exactly one completion, one
    // successful delivery (2 handler runs total: 1 failed + 1 success).
    expect(options.processEvent).toHaveBeenCalledTimes(2);
    expect(inboundEvents.markFailed).toHaveBeenCalledTimes(1);
    expect(inboundEvents.markCompleted).toHaveBeenCalledWith(1);
  });

  it('replays pending rows (crash between ingest and processing)', async () => {
    const options = buildOptions();
    const { service, inboundEvents } = buildService(options);
    inboundEvents.listDue.mockResolvedValue([row({ status: 'pending' })]);

    await service.handleRetry();

    expect(options.processEvent).toHaveBeenCalledTimes(1);
    expect(inboundEvents.markCompleted).toHaveBeenCalledWith(1);
  });

  it('does not run when the advisory lock is held by another pod', async () => {
    const options = buildOptions();
    const { service, inboundEvents, pgLock } = buildService(options);
    pgLock.withLock.mockResolvedValue(null);

    await service.handleRetry();

    expect(inboundEvents.listDue).not.toHaveBeenCalled();
  });

  it('claims each event before processing and skips already-claimed rows', async () => {
    const options = buildOptions();
    const { service, inboundEvents } = buildService(options);
    inboundEvents.listDue.mockResolvedValue([row({ id: 1 }), row({ id: 2 })]);
    inboundEvents.claim
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false);

    await service.handleRetry();

    expect(inboundEvents.claim).toHaveBeenCalledTimes(2);
    expect(options.processEvent).toHaveBeenCalledTimes(1);
    expect(inboundEvents.markCompleted).toHaveBeenCalledWith(1);
    expect(inboundEvents.markCompleted).not.toHaveBeenCalledWith(2);
  });

  it('terminalizes stale processing rows without replaying side effects', async () => {
    const options = buildOptions();
    const { service, inboundEvents } = buildService(options);
    inboundEvents.listDue.mockResolvedValue([
      row({ id: 9, status: 'processing' }),
    ]);

    await service.handleRetry();

    expect(inboundEvents.listDue).toHaveBeenCalledWith(
      expect.objectContaining({ processingStuckMs: 300_000 }),
    );
    expect(inboundEvents.abandonStaleProcessing).toHaveBeenCalledWith(
      9,
      expect.any(Date),
    );
    expect(inboundEvents.claim).not.toHaveBeenCalled();
    expect(options.processEvent).not.toHaveBeenCalled();
    expect(inboundEvents.markProcessingAbandoned).not.toHaveBeenCalled();
  });

  it('terminalizes an event when completion cannot be recorded', async () => {
    const options = buildOptions();
    const { service, inboundEvents } = buildService(options);
    inboundEvents.listDue.mockResolvedValue([row()]);
    inboundEvents.markCompleted.mockRejectedValue(new Error('DB hiccup'));

    await service.handleRetry();

    expect(inboundEvents.markFailed).not.toHaveBeenCalled();
    expect(inboundEvents.markProcessingAbandoned).toHaveBeenCalledWith(
      1,
      'DB hiccup',
    );
  });

  it('reads retry config from env with defaults', async () => {
    const options = buildOptions({
      processEvent: jest.fn().mockRejectedValue(new Error('boom')),
    });
    const { service, inboundEvents, configGet } = buildService(options);
    configGet.mockImplementation((key: string) =>
      key === 'WEBHOOK_INBOUND_MAX_RETRIES' ? '2' : undefined,
    );
    inboundEvents.listDue.mockResolvedValue([row({ retryCount: 1 })]);

    await service.handleRetry();

    expect(inboundEvents.markFailed).toHaveBeenCalledWith(
      1,
      'boom',
      expect.objectContaining({ maxRetries: 2 }),
    );
  });

  it('logs eventId with the embedded external id masked (redaction)', async () => {
    const options = buildOptions({
      processEvent: jest.fn().mockRejectedValue(new Error('WISPACE down')),
    });
    const { service, inboundEvents } = buildService(options);
    inboundEvents.listDue.mockResolvedValue([
      row({
        id: 5,
        eventId: 'pb:psid-123456789:GET_STARTED:1699000000000',
        externalUserId: 'psid-123456789',
      }),
    ]);

    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    await service.handleRetry();
    // Capture calls BEFORE restoring — mockRestore() clears mock state.
    const warnCalls = warnSpy.mock.calls;
    warnSpy.mockRestore();

    for (const [message] of warnCalls) {
      expect(String(message)).not.toContain('psid-123456789');
      expect(String(message)).not.toContain(
        'pb:psid-123456789:GET_STARTED:1699000000000',
      );
    }
    // Masked form still allows correlation across logs.
    expect(
      warnCalls.some(([message]) => String(message).includes('pb:psid…6789')),
    ).toBe(true);
  });
});
