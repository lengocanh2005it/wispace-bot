/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { ConfigService } from '@nestjs/config';
import type { DiscordAccountLinkRepositoryPort } from '../../domain/ports/discord-account-link.repository.port';
import { DiscordAccountLinkService } from './discord-account-link.service';

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

function buildRepositoryPort(): DiscordAccountLinkRepositoryPort {
  return {
    upsertLink: jest.fn().mockResolvedValue({ relinked: false }),
    findUserIdByDiscordId: jest.fn(),
    findDiscordIdByUserId: jest.fn(),
  };
}

describe('DiscordAccountLinkService', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  describe('exchangeCodeForDiscordUser', () => {
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

      const service = new DiscordAccountLinkService(
        buildConfigService(),
        buildRepositoryPort(),
      );

      const result = await service.exchangeCodeForDiscordUser('auth-code');

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

      const service = new DiscordAccountLinkService(
        buildConfigService(),
        buildRepositoryPort(),
      );

      const result = await service.exchangeCodeForDiscordUser('auth-code');

      expect(result).toEqual({ id: 'discord-user-1', username: 'testuser' });
    });

    it('throws when the token exchange fails', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
      }) as typeof fetch;

      const service = new DiscordAccountLinkService(
        buildConfigService(),
        buildRepositoryPort(),
      );

      await expect(
        service.exchangeCodeForDiscordUser('bad-code'),
      ).rejects.toThrow('Discord token exchange failed: 400');
    });
  });

  describe('upsertLink / findUserIdByDiscordId', () => {
    it('delegates the upsert to the repository port and logs the link', async () => {
      const repository = buildRepositoryPort();
      const service = new DiscordAccountLinkService(
        buildConfigService(),
        repository,
      );

      const result = await service.upsertLink(143, 'discord-user-1');

      expect(repository.upsertLink).toHaveBeenCalledWith(143, 'discord-user-1');
      expect(result).toEqual({ relinked: false });
    });

    it('returns the linked userId when found', async () => {
      const repository = buildRepositoryPort();
      (repository.findUserIdByDiscordId as jest.Mock).mockResolvedValue(143);
      const service = new DiscordAccountLinkService(
        buildConfigService(),
        repository,
      );

      await expect(
        service.findUserIdByDiscordId('discord-user-1'),
      ).resolves.toBe(143);
    });

    it('returns undefined when no link exists', async () => {
      const repository = buildRepositoryPort();
      (repository.findUserIdByDiscordId as jest.Mock).mockResolvedValue(
        undefined,
      );
      const service = new DiscordAccountLinkService(
        buildConfigService(),
        repository,
      );

      await expect(
        service.findUserIdByDiscordId('discord-user-unknown'),
      ).resolves.toBeUndefined();
    });
  });
});
