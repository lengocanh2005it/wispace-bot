import { ConfigService } from '@nestjs/config';
import { ZaloOAuthHttpAdapter } from './zalo-oauth-http.adapter';

function buildConfig(): ConfigService {
  return {
    getOrThrow: (key: string) =>
      ({ ZALO_APP_ID: 'app-1', ZALO_APP_SECRET_KEY: 'secret-1' })[key],
  } as unknown as ConfigService;
}

describe('ZaloOAuthHttpAdapter', () => {
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  it('exchanges the PKCE code and fetches the Zalo profile', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'user-token-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ id: 'zalo-user-1', name: 'Nguyen Van A' }),
      });
    global.fetch = fetchMock;
    const adapter = new ZaloOAuthHttpAdapter(buildConfig());

    await expect(
      adapter.exchangeCodeForUser('auth-code', 'verifier-1'),
    ).resolves.toEqual({ id: 'zalo-user-1', name: 'Nguyen Van A' });
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://oauth.zaloapp.com/v4/access_token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://graph.zalo.me/v2.0/me?fields=id,name',
      expect.objectContaining({
        headers: { access_token: 'user-token-1' },
      }),
    );
  });

  it('refreshes an OA token pair and converts lifetimes to absolute dates', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'access-2',
          refresh_token: 'refresh-2',
          expires_in: '3600',
          refresh_token_expires_in: '2592000',
        }),
    });
    const adapter = new ZaloOAuthHttpAdapter(buildConfig());

    const pair = await adapter.refreshOaToken('refresh-1');

    expect(pair.accessToken).toBe('access-2');
    expect(pair.refreshToken).toBe('refresh-2');
    expect(pair.accessTokenExpiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(pair.refreshTokenExpiresAt.getTime()).toBeGreaterThan(
      pair.accessTokenExpiresAt.getTime(),
    );
  });

  it('rejects non-success responses and invalid refresh payloads before persistence', async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 401 })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            access_token: 'access-2',
            refresh_token: 'refresh-2',
            expires_in: 'not-a-number',
            refresh_token_expires_in: '2592000',
          }),
      });
    const adapter = new ZaloOAuthHttpAdapter(buildConfig());

    await expect(adapter.refreshOaToken('refresh-1')).rejects.toThrow(
      'HTTP 401',
    );
    await expect(adapter.refreshOaToken('refresh-1')).rejects.toThrow(
      'invalid payload',
    );
  });
});
