import { ConfigService } from '@nestjs/config';
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
    listDue: jest.Mock<Promise<InboundEventRow[]>, [{ limit: number }]>;
    markCompleted: jest.Mock;
    markFailed: jest.Mock;
  };
  configGet: jest.Mock<unknown, [string]>;
  pgLock: { withLock: jest.Mock };
} {
  const inboundEvents = {
    listDue: jest
      .fn<Promise<InboundEventRow[]>, [{ limit: number }]>()
      .mockResolvedValue([]),
    markCompleted: jest.fn().mockResolvedValue(undefined),
    markFailed: jest.fn().mockResolvedValue(undefined),
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
});
