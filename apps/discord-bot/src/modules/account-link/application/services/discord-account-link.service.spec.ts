/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { DiscordAccountLinkRepositoryPort } from '../../domain/ports/discord-account-link.repository.port';
import type { DiscordOauthExchangePort } from '../../domain/ports/discord-oauth-exchange.port';
import { DiscordAccountLinkService } from './discord-account-link.service';

function buildOauthExchange(): DiscordOauthExchangePort {
  return {
    exchangeCodeForDiscordUser: jest
      .fn()
      .mockResolvedValue({ id: 'discord-user-1', username: 'Test User' }),
  };
}

function buildRepositoryPort(): DiscordAccountLinkRepositoryPort {
  return {
    upsertLink: jest.fn().mockResolvedValue({ relinked: false }),
    findUserIdByDiscordId: jest.fn(),
    findDiscordIdByUserId: jest.fn(),
    claimConsentPrompt: jest.fn().mockResolvedValue(false),
    releaseConsentPrompt: jest.fn().mockResolvedValue(undefined),
    suppressOptOutNotice: jest.fn().mockResolvedValue(undefined),
  };
}

describe('DiscordAccountLinkService', () => {
  describe('exchangeCodeForDiscordUser', () => {
    it('delegates the OAuth exchange to the port (#428)', async () => {
      const oauthExchange = buildOauthExchange();
      const service = new DiscordAccountLinkService(
        oauthExchange,
        buildRepositoryPort(),
      );

      const result = await service.exchangeCodeForDiscordUser('auth-code');

      expect(result).toEqual({ id: 'discord-user-1', username: 'Test User' });
      expect(oauthExchange.exchangeCodeForDiscordUser).toHaveBeenCalledWith(
        'auth-code',
      );
    });
  });

  describe('upsertLink / findUserIdByDiscordId', () => {
    it('delegates the upsert to the repository port and logs the link', async () => {
      const repository = buildRepositoryPort();
      const service = new DiscordAccountLinkService(
        buildOauthExchange(),
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
        buildOauthExchange(),
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
        buildOauthExchange(),
        repository,
      );

      await expect(
        service.findUserIdByDiscordId('discord-user-unknown'),
      ).resolves.toBeUndefined();
    });
  });

  describe('sendConsentExplainerIfDue (#596 AC5)', () => {
    it('sends the explainer exactly once — claim win sends, claim loss skips', async () => {
      const repository = buildRepositoryPort();
      (repository.claimConsentPrompt as jest.Mock)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      const service = new DiscordAccountLinkService(
        buildOauthExchange(),
        repository,
      );
      const send = jest.fn().mockResolvedValue(undefined);

      const first = await service.sendConsentExplainerIfDue(
        'discord-user-1',
        send,
      );
      const second = await service.sendConsentExplainerIfDue(
        'discord-user-1',
        send,
      );

      expect(first).toBe(true);
      expect(second).toBe(false);
      expect(send).toHaveBeenCalledTimes(1);
      expect(send).toHaveBeenCalledWith(expect.stringContaining('báo cáo'));
      expect(repository.releaseConsentPrompt).not.toHaveBeenCalled();
    });

    it('releases the claim when the send fails so a later path can retry', async () => {
      const repository = buildRepositoryPort();
      (repository.claimConsentPrompt as jest.Mock).mockResolvedValue(true);
      const service = new DiscordAccountLinkService(
        buildOauthExchange(),
        repository,
      );
      const send = jest.fn().mockRejectedValue(new Error('DM failed'));

      const result = await service.sendConsentExplainerIfDue(
        'discord-user-1',
        send,
      );

      expect(result).toBe(false);
      expect(repository.releaseConsentPrompt).toHaveBeenCalledWith(
        'discord-user-1',
      );
    });
  });
});
