import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import type { DiscordAccountLinkEntity } from '@discord/infrastructure/database/entities/discord-account-link.entity';
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

      const repo = {} as Repository<DiscordAccountLinkEntity>;
      const service = new DiscordAccountLinkService(buildConfigService(), repo);

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

      const repo = {} as Repository<DiscordAccountLinkEntity>;
      const service = new DiscordAccountLinkService(buildConfigService(), repo);

      const result = await service.exchangeCodeForDiscordUser('auth-code');

      expect(result).toEqual({ id: 'discord-user-1', username: 'testuser' });
    });

    it('throws when the token exchange fails', async () => {
      global.fetch = jest.fn().mockResolvedValue({
        ok: false,
        status: 400,
      }) as typeof fetch;

      const repo = {} as Repository<DiscordAccountLinkEntity>;
      const service = new DiscordAccountLinkService(buildConfigService(), repo);

      await expect(
        service.exchangeCodeForDiscordUser('bad-code'),
      ).rejects.toThrow('Discord token exchange failed: 400');
    });
  });

  describe('upsertLink / findUserIdByDiscordId', () => {
    it('upserts via transaction: deletes old link then inserts', async () => {
      const query = jest.fn().mockResolvedValue([]);
      const repo = {
        manager: {
          transaction: jest.fn((fn: (em: unknown) => Promise<void>) =>
            fn({ query }),
          ),
        },
      } as unknown as Repository<DiscordAccountLinkEntity>;
      const service = new DiscordAccountLinkService(buildConfigService(), repo);

      await service.upsertLink(143, 'discord-user-1');

      // First call: DELETE old link for userId
      expect(query).toHaveBeenNthCalledWith(
        1,
        expect.stringContaining('DELETE FROM discord_account_links'),
        ['discord', 143, 'discord-user-1'],
      );
      // Second call: INSERT new link
      expect(query).toHaveBeenNthCalledWith(
        2,
        expect.stringContaining('INSERT INTO discord_account_links'),
        ['discord', 'discord-user-1', 143],
      );
    });

    it('returns the linked userId when found', async () => {
      const findOne = jest.fn().mockResolvedValue({ userId: 143 });
      const repo = {
        findOne,
      } as unknown as Repository<DiscordAccountLinkEntity>;
      const service = new DiscordAccountLinkService(buildConfigService(), repo);

      await expect(
        service.findUserIdByDiscordId('discord-user-1'),
      ).resolves.toBe(143);
    });

    it('returns undefined when no link exists', async () => {
      const findOne = jest.fn().mockResolvedValue(null);
      const repo = {
        findOne,
      } as unknown as Repository<DiscordAccountLinkEntity>;
      const service = new DiscordAccountLinkService(buildConfigService(), repo);

      await expect(
        service.findUserIdByDiscordId('discord-user-unknown'),
      ).resolves.toBeUndefined();
    });
  });
});
