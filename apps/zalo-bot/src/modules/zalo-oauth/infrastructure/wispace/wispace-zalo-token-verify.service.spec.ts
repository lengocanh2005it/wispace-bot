import { ConfigService } from '@nestjs/config';
import { WispaceZaloTokenVerifyService } from './wispace-zalo-token-verify.service';

function buildConfig(): ConfigService {
  return {
    get: (key: string) =>
      ({
        WISPACE_API_VERIFY_TOKEN_URL:
          'https://wispace.example.com/verify-token-url',
        WISPACE_INTERNAL_KEY: 'internal-key-1',
      })[key],
  } as unknown as ConfigService;
}

describe('WispaceZaloTokenVerifyService', () => {
  it('returns valid:true with userId on success', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      text: () => Promise.resolve(JSON.stringify({ userId: 42 })),
    });
    const service = new WispaceZaloTokenVerifyService(buildConfig(), fetchMock);

    const result = await service.verifyToken('link-token', 'zalo-1');

    expect(result).toEqual({ valid: true, userId: 42 });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://wispace.example.com/verify-token-url',
      expect.objectContaining({
        method: 'POST',
      }),
    );
    const fetchCalls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    const headers = fetchCalls[0]?.[1].headers as Record<string, string>;
    expect(headers['X-Internal-Key']).toBe('internal-key-1');

    const bodyText = fetchCalls[0]?.[1].body;
    if (typeof bodyText !== 'string') {
      throw new Error('expected fetch body to be a string');
    }
    expect(JSON.parse(bodyText)).toEqual({
      token: 'link-token',
      value: 'zalo-1',
      platform: 'zalo',
    });
  });

  it('returns valid:false with a reason on a known failure response', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: false,
      text: () => Promise.resolve(JSON.stringify({ reason: 'EXPIRED' })),
    });
    const service = new WispaceZaloTokenVerifyService(buildConfig(), fetchMock);

    const result = await service.verifyToken('link-token', 'zalo-1');

    expect(result).toEqual({ valid: false, reason: 'EXPIRED' });
  });
});
