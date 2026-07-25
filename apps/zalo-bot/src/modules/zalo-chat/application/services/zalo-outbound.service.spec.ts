import { ZaloOutboundService } from './zalo-outbound.service';
import { ZaloTokenService } from '../../../zalo-oauth/application/services/zalo-token.service';

describe('ZaloOutboundService', () => {
  it('sends a text consultation message with the current access token', async () => {
    const getValidAccessToken = jest.fn().mockResolvedValue('token-abc');
    const tokenService = { getValidAccessToken } as unknown as ZaloTokenService;
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ error: 0, message: 'Success', data: {} }),
    });

    const service = new ZaloOutboundService(tokenService, fetchMock);
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
  });

  it('logs and swallows errors instead of throwing (best-effort send, matches Discord pattern)', async () => {
    const tokenService = {
      getValidAccessToken: jest.fn().mockResolvedValue('token-abc'),
    } as unknown as ZaloTokenService;
    const fetchMock = jest.fn().mockRejectedValue(new Error('network down'));

    const service = new ZaloOutboundService(tokenService, fetchMock);

    await expect(service.sendText('zalo-1', 'hello')).resolves.toBeUndefined();
  });
});
