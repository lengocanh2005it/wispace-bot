import { ZaloOutboundService, ZaloSendError } from './zalo-outbound.service';
import { ZaloTokenService } from '@zalo/modules/zalo-oauth/application/services/zalo-token.service';

describe('ZaloOutboundService', () => {
  const deliveryLog = {
    logDelivery: jest.fn().mockResolvedValue(undefined),
  };

  beforeEach(() => {
    deliveryLog.logDelivery.mockClear();
  });

  it('sends a text consultation message with the current access token', async () => {
    const getValidAccessToken = jest.fn().mockResolvedValue('token-abc');
    const tokenService = { getValidAccessToken } as unknown as ZaloTokenService;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: 0, message: 'Success', data: {} }),
    });

    global.fetch = fetchMock;

    const service = new ZaloOutboundService(tokenService, deliveryLog as never);
    await service.sendText('zalo-1', 'hello');

    expect(getValidAccessToken).toHaveBeenCalled();
    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    expect(calls[0]?.[0]).toBe('https://openapi.zalo.me/v3.0/oa/message/cs');
    expect(calls[0]?.[1].method).toBe('POST');
    const headers = calls[0]?.[1].headers as Record<string, string>;
    expect(headers['access_token']).toBe('token-abc');

    const bodyText = calls[0]?.[1].body;
    if (typeof bodyText !== 'string') {
      throw new Error('expected fetch body to be a string');
    }
    expect(JSON.parse(bodyText)).toEqual({
      recipient: { user_id: 'zalo-1' },
      message: { text: 'hello' },
    });

    delete global.fetch;
  });

  it('throws ZaloSendError on network failure instead of swallowing', async () => {
    const tokenService = {
      getValidAccessToken: jest.fn().mockResolvedValue('token-abc'),
    } as unknown as ZaloTokenService;
    const fetchMock = jest.fn().mockRejectedValue(new Error('network down'));

    global.fetch = fetchMock;

    const service = new ZaloOutboundService(tokenService, deliveryLog as never);

    await expect(service.sendText('zalo-1', 'hello')).rejects.toThrow(
      'Zalo Send API network error',
    );

    delete global.fetch;
  });

  it('redacts error strings while retaining raw payload for replay', async () => {
    const tokenService = {
      getValidAccessToken: jest.fn().mockResolvedValue('token-abc'),
    } as unknown as ZaloTokenService;
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    const deadLetter = {
      save: jest
        .fn<Promise<void>, [{ errorMessage: string; rawPayload: unknown }]>()
        .mockResolvedValue(undefined),
    };
    const service = new ZaloOutboundService(
      tokenService,
      deliveryLog as never,
      deadLetter as never,
    );

    await expect(service.sendText('zalo-1', 'hello')).rejects.toThrow(
      ZaloSendError,
    );
    const err = await service
      .sendText('zalo-1', 'hello')
      .catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('zalo-1');
    const saved = deadLetter.save.mock.calls[0]?.[0];
    expect(saved?.errorMessage).not.toContain('zalo-1');
    expect(saved?.rawPayload).toEqual({ zaloUserId: 'zalo-1', text: 'hello' });

    delete global.fetch;
  });

  it('redacts external ids echoed by the Zalo API error body', async () => {
    const tokenService = {
      getValidAccessToken: jest.fn().mockResolvedValue('token-abc'),
    } as unknown as ZaloTokenService;
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Server Error',
      json: () =>
        Promise.resolve({
          error: 500,
          message: 'failed for zalo-1234567890',
        }),
    });
    const deadLetter = {
      save: jest
        .fn<Promise<void>, [{ errorMessage: string; rawPayload: unknown }]>()
        .mockResolvedValue(undefined),
    };
    const service = new ZaloOutboundService(
      tokenService,
      deliveryLog as never,
      deadLetter as never,
    );

    await expect(service.sendText('zalo-1234567890', 'hello')).rejects.toThrow(
      'zalo…7890',
    );
    const saved = deadLetter.save.mock.calls[0]?.[0];
    expect(saved.errorMessage).not.toContain('zalo-1234567890');
    expect(saved.rawPayload).toEqual({
      zaloUserId: 'zalo-1234567890',
      text: 'hello',
    });

    delete global.fetch;
  });

  it('does not mark a 2xx application error as delivered', async () => {
    const tokenService = {
      getValidAccessToken: jest.fn().mockResolvedValue('token-abc'),
    } as unknown as ZaloTokenService;
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: 4001, message: 'Invalid user id' }),
    });

    const service = new ZaloOutboundService(tokenService, deliveryLog as never);

    await expect(service.sendText('zalo-1', 'hello')).rejects.toMatchObject({
      status: 4001,
    });
    expect(deliveryLog.logDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'FAILED' }),
    );

    delete global.fetch;
  });
});
