/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { BotMetricsService } from '@wispace/bot-metrics';
import type { ZaloOaAccessTokenPort } from '@zalo/modules/zalo-oauth/application/ports/zalo-oa-token-store.port';
import type {
  ZaloOutboundTransportPort,
  ZaloOutboundTransportResult,
} from '../ports/zalo-outbound-transport.port';
import { ZaloOutboundService, ZaloSendError } from './zalo-outbound.service';

const deliveryLog = {
  logDelivery: jest.fn().mockResolvedValue(undefined),
};

function buildJournal(saveDeadLetter?: jest.Mock): {
  logDelivery: jest.Mock;
  saveDeadLetter: jest.Mock;
} {
  return {
    logDelivery: deliveryLog.logDelivery,
    saveDeadLetter: saveDeadLetter ?? jest.fn().mockResolvedValue(false),
  };
}

function successResult(): ZaloOutboundTransportResult {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    responseBody: JSON.stringify({ error: 0, message: 'Success', data: {} }),
    applicationError: 0,
  };
}

function failureResult(
  status: number,
  body: unknown,
): ZaloOutboundTransportResult {
  return {
    ok: false,
    status,
    statusText: status >= 500 ? 'Server Error' : 'Bad Request',
    responseBody: JSON.stringify(body),
    applicationError:
      body && typeof body === 'object' && 'error' in body
        ? Number((body as { error: unknown }).error)
        : 0,
  };
}

function buildTokenService(): ZaloOaAccessTokenPort {
  return {
    getValidAccessToken: jest.fn().mockResolvedValue('token-abc'),
    refreshNow: jest.fn(),
  };
}

function buildTransport(
  implementation: ZaloOutboundTransportPort['sendText'] = jest
    .fn()
    .mockResolvedValue(successResult()),
): ZaloOutboundTransportPort {
  return { sendText: implementation };
}

function buildMetricsStub(): BotMetricsService {
  return {
    incDmDeliveryFailure: jest.fn(),
  } as unknown as BotMetricsService;
}

describe('ZaloOutboundService', () => {
  beforeEach(() => {
    deliveryLog.logDelivery.mockClear();
  });

  it('returns rate_limited before token or transport work', async () => {
    const tokenService = buildTokenService();
    const transport = buildTransport();
    const limiter = {
      admit: jest.fn().mockResolvedValue({
        allowed: false,
        outcome: 'limited',
        reason: 'cap_exceeded',
      }),
    };
    const service = new ZaloOutboundService(
      tokenService,
      transport,
      buildJournal() as never,
      undefined,
      limiter as never,
    );

    await expect(service.sendText('zalo-1', 'hello')).resolves.toBe(
      'rate_limited',
    );
    expect(tokenService.getValidAccessToken).not.toHaveBeenCalled();
    expect(transport.sendText).not.toHaveBeenCalled();
  });

  it('sends a text message through the transport with the current access token', async () => {
    const tokenService = buildTokenService();
    const sendText = jest.fn().mockResolvedValue(successResult());
    const service = new ZaloOutboundService(
      tokenService,
      buildTransport(sendText),
      buildJournal() as never,
    );

    await expect(service.sendText('zalo-1', 'hello')).resolves.toBe('sent');
    expect(sendText).toHaveBeenCalledWith(
      expect.objectContaining({
        recipientId: 'zalo-1',
        text: 'hello',
        accessToken: 'token-abc',
      }),
    );
    expect(deliveryLog.logDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'SENT' }),
    );
  });

  it('throws an ambiguous ZaloSendError on a network failure', async () => {
    const transport = buildTransport(
      jest.fn().mockRejectedValue(new Error('network down')),
    );
    const service = new ZaloOutboundService(
      buildTokenService(),
      transport,
      buildJournal() as never,
    );

    await expect(service.sendText('zalo-1', 'hello')).rejects.toThrow(
      'Zalo Send API network error',
    );
    expect(deliveryLog.logDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );
  });

  it('redacts error strings while retaining raw payload for replay', async () => {
    const deadLetter = {
      save: jest.fn().mockResolvedValue(undefined),
    };
    const service = new ZaloOutboundService(
      buildTokenService(),
      buildTransport(jest.fn().mockRejectedValue(new Error('network down'))),
      buildJournal(deadLetter.save) as never,
    );

    const error = await service
      .sendText('zalo-1', 'hello')
      .catch((value: unknown) => value);
    expect(error).toBeInstanceOf(ZaloSendError);
    expect((error as Error).message).not.toContain('zalo-1');
    expect(deadLetter.save).toHaveBeenCalledWith(
      expect.objectContaining({
        errorMessage: expect.not.stringContaining('zalo-1'),
        rawPayload: { zaloUserId: 'zalo-1', text: 'hello' },
      }),
    );
  });

  it('does not mark a 2xx application error as delivered', async () => {
    const service = new ZaloOutboundService(
      buildTokenService(),
      buildTransport(
        jest
          .fn()
          .mockResolvedValue(
            failureResult(200, { error: 4001, message: 'Invalid user id' }),
          ),
      ),
      buildJournal() as never,
    );

    await expect(service.sendText('zalo-1', 'hello')).rejects.toMatchObject({
      status: 4001,
    });
    expect(deliveryLog.logDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );
  });

  it('does not retry known 4xx API errors', async () => {
    const sendText = jest
      .fn()
      .mockResolvedValue(
        failureResult(400, { error: 4001, message: 'Invalid user id' }),
      );
    const metrics = buildMetricsStub();
    const service = new ZaloOutboundService(
      buildTokenService(),
      buildTransport(sendText),
      buildJournal() as never,
      metrics,
    );

    await expect(service.sendText('zalo-1', 'hello')).rejects.toThrow();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(metrics.incDmDeliveryFailure).not.toHaveBeenCalledWith(
      'dm_send_ambiguous',
    );
  });

  it('retries 5xx provider errors', async () => {
    const sendText = jest
      .fn()
      .mockResolvedValue(
        failureResult(503, { error: 503, message: 'temporary outage' }),
      );
    const service = new ZaloOutboundService(
      buildTokenService(),
      buildTransport(sendText),
      buildJournal() as never,
    );

    await expect(service.sendText('zalo-1', 'hello')).rejects.toThrow();
    expect(sendText).toHaveBeenCalledTimes(2);
  });

  it('lets the report outbox own retryable delivery without a second local send', async () => {
    const sendText = jest
      .fn()
      .mockResolvedValue(
        failureResult(503, { error: 503, message: 'temporary outage' }),
      );
    const deadLetter = { save: jest.fn().mockResolvedValue(true) };
    const service = new ZaloOutboundService(
      buildTokenService(),
      buildTransport(sendText),
      buildJournal(deadLetter.save) as never,
    );

    await expect(
      service.sendText('zalo-1', 'report', {
        deliveryKey: 'zalo-report:zalo-1:2026-08-30',
        deadLetterOn: 'ambiguous',
        retryOn: 'none',
      }),
    ).rejects.toBeInstanceOf(ZaloSendError);
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(deadLetter.save).not.toHaveBeenCalled();
  });

  it('retries network errors and records ambiguous delivery', async () => {
    const sendText = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const metrics = buildMetricsStub();
    const service = new ZaloOutboundService(
      buildTokenService(),
      buildTransport(sendText),
      buildJournal() as never,
      metrics,
    );

    await expect(service.sendText('zalo-1', 'hello')).rejects.toThrow();
    expect(sendText).toHaveBeenCalledTimes(2);
    expect(metrics.incDmDeliveryFailure).toHaveBeenCalledWith(
      'dm_send_ambiguous',
    );
  });

  it('does not retry or dead-letter an ambiguous clarification delivery', async () => {
    const sendText = jest.fn().mockRejectedValue(new TypeError('fetch failed'));
    const deadLetter = { save: jest.fn().mockResolvedValue(true) };
    const service = new ZaloOutboundService(
      buildTokenService(),
      buildTransport(sendText),
      buildJournal(deadLetter.save) as never,
    );

    await expect(
      service.sendText('zalo-1', 'Mình chưa rõ.', {
        deliveryKey: 'clarification:zalo:event-401',
        clarification: true,
      }),
    ).rejects.toThrow();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(deadLetter.save).not.toHaveBeenCalled();
  });

  it('persists a definitive clarification failure for outbound replay', async () => {
    const deadLetter = { save: jest.fn().mockResolvedValue(true) };
    const service = new ZaloOutboundService(
      buildTokenService(),
      buildTransport(
        jest
          .fn()
          .mockResolvedValue(
            failureResult(400, { error: 4001, message: 'Invalid user id' }),
          ),
      ),
      buildJournal(deadLetter.save) as never,
    );

    await expect(
      service.sendText('zalo-1', 'Mình chưa rõ.', {
        deliveryKey: 'clarification:zalo:event-401',
        clarification: true,
      }),
    ).rejects.toThrow();
    expect(deadLetter.save).toHaveBeenCalledWith(
      expect.objectContaining({
        direction: 'outbound',
        deliveryKey: 'clarification:zalo:event-401',
      }),
    );
  });

  it('does not retry a timeout after acceptance and records ambiguity', async () => {
    const timeout = Object.assign(new Error('request timed out'), {
      name: 'TimeoutError',
    });
    const sendText = jest.fn().mockRejectedValue(timeout);
    const metrics = buildMetricsStub();
    const service = new ZaloOutboundService(
      buildTokenService(),
      buildTransport(sendText),
      buildJournal() as never,
      metrics,
    );

    await expect(service.sendText('zalo-1', 'hello')).rejects.toThrow();
    expect(sendText).toHaveBeenCalledTimes(1);
    expect(metrics.incDmDeliveryFailure).toHaveBeenCalledWith(
      'dm_send_ambiguous',
    );
  });
});
