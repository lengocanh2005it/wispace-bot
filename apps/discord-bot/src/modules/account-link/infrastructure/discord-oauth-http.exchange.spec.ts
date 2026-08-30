/* eslint-disable @typescript-eslint/no-unsafe-assignment -- partial fetch mocks */
import { ConfigService } from '@nestjs/config';
import { DiscordOauthHttpExchange } from './discord-oauth-http.exchange';

const CONFIG_VALUES: Record<string, string> = {
  DISCORD_CLIENT_ID: 'client-id',
  DISCORD_CLIENT_SECRET: 'client-secret',
  DISCORD_OAUTH_REDIRECT_URI: 'https://bot.example.com/discord/oauth/callback',
};

function buildConfigService(): ConfigService {
  return {
    getOrThrow: (key: string) => CONFIG_VALUES[key],
  } as unknown as ConfigService;
}

describe('DiscordOauthHttpExchange (#428)', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('exchanges the code for a token then fetches the Discord user', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'discord-token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ id: 'discord-user-1', global_name: 'Test User' }),
      });
    global.fetch = fetchMock as typeof fetch;

    const exchange = new DiscordOauthHttpExchange(buildConfigService());

    const result = await exchange.exchangeCodeForDiscordUser('auth-code');

    expect(result).toEqual({ id: 'discord-user-1', username: 'Test User' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock).toHaveBeenNthCalledWith(
      1,
      'https://discord.com/api/oauth2/token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      'https://discord.com/api/users/@me',
      expect.objectContaining({
        headers: { Authorization: 'Bearer discord-token' },
      }),
    );
  });

  it('falls back to username when global_name is absent', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'discord-token' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({ id: 'discord-user-1', username: 'testuser' }),
      });
    global.fetch = fetchMock as typeof fetch;

    const exchange = new DiscordOauthHttpExchange(buildConfigService());

    const result = await exchange.exchangeCodeForDiscordUser('auth-code');

    expect(result).toEqual({ id: 'discord-user-1', username: 'testuser' });
  });

  it('throws when the token exchange fails', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: false,
      status: 400,
    }) as typeof fetch;

    const exchange = new DiscordOauthHttpExchange(buildConfigService());

    await expect(
      exchange.exchangeCodeForDiscordUser('bad-code'),
    ).rejects.toThrow('Discord token exchange failed: 400');
  });
});
