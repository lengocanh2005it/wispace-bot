import type { Repository } from 'typeorm';
import type { DiscordAccountLinkEntity } from '@discord/infrastructure/database/entities/discord-account-link.entity';
import { TypeormDiscordAccountLinkRepository } from './typeorm-discord-account-link.repository';

describe('TypeormDiscordAccountLinkRepository', () => {
  it('upserts via transaction: detects existing mapping, deletes old link then inserts', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ external_user_id: 'discord-user-1' }]);
    const repo = {
      manager: {
        transaction: jest.fn((fn: (em: unknown) => Promise<void>) =>
          fn({ query }),
        ),
      },
    } as unknown as Repository<DiscordAccountLinkEntity>;
    const service = new TypeormDiscordAccountLinkRepository(repo);

    const result = await service.upsertLink(143, 'discord-user-1');

    // First call: SELECT existing mapping for the Discord id (relink detection)
    expect(query).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('SELECT user_id, mapping_generation'),
      ['discord', 'discord-user-1'],
    );
    // Second call: DELETE old link for userId
    expect(query).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('DELETE FROM discord_account_links'),
      ['discord', 143, 'discord-user-1'],
    );
    // Third call: INSERT new link
    expect(query).toHaveBeenNthCalledWith(
      3,
      expect.stringContaining('INSERT INTO discord_account_links'),
      ['discord', 'discord-user-1', 143, null],
    );
    expect(result).toEqual({ relinked: false });
  });

  it('#137: reports relinked + the displaced userId when the Discord id moves to another WISPACE user', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ user_id: 99 }])
      .mockResolvedValueOnce([])
      .mockResolvedValue([{ external_user_id: 'discord-user-1' }]);
    const repo = {
      manager: {
        transaction: jest.fn((fn: (em: unknown) => Promise<void>) =>
          fn({ query }),
        ),
      },
    } as unknown as Repository<DiscordAccountLinkEntity>;
    const service = new TypeormDiscordAccountLinkRepository(repo);

    const result = await service.upsertLink(143, 'discord-user-1');

    expect(result).toEqual({ relinked: true, previousUserId: 99 });
  });

  it('rejects a fenced upsert when the mapping generation changed', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const repo = {
      manager: {
        transaction: jest.fn((fn: (em: unknown) => Promise<void>) =>
          fn({ query }),
        ),
      },
    } as unknown as Repository<DiscordAccountLinkEntity>;
    const service = new TypeormDiscordAccountLinkRepository(repo);

    await expect(
      service.upsertLink(143, 'discord-user-1', { expectedGeneration: '4' }),
    ).rejects.toThrow(/stale|revoked/i);
    const lastCall = query.mock.calls[query.mock.calls.length - 1];
    expect(lastCall?.[0]).toContain('mapping_generation');
    expect(lastCall?.[0]).not.toContain("link_state <> 'confirmed-revoked'");
  });

  it('checks the generation before removing another link for the user', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { user_id: 143, mapping_generation: '5', link_state: 'active' },
      ]);
    const repo = {
      manager: {
        transaction: jest.fn((fn: (em: unknown) => Promise<void>) =>
          fn({ query }),
        ),
      },
    } as unknown as Repository<DiscordAccountLinkEntity>;
    const service = new TypeormDiscordAccountLinkRepository(repo);

    await expect(
      service.upsertLink(143, 'discord-user-1', { expectedGeneration: '4' }),
    ).rejects.toThrow(/stale|revoked/i);
    expect(query).toHaveBeenCalledTimes(1);
  });

  describe('consent prompt claim (#596 AC5)', () => {
    const buildRepo = (query: jest.Mock) =>
      new TypeormDiscordAccountLinkRepository({
        query,
      } as unknown as Repository<DiscordAccountLinkEntity>);

    it('claims once — the second claim loses (not repeated on reconnect)', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce([{ id: '1' }])
        .mockResolvedValueOnce([]);
      const service = buildRepo(query);

      const first = await service.claimConsentPrompt('discord-user-1');
      const second = await service.claimConsentPrompt('discord-user-1');

      expect(first).toBe(true);
      expect(second).toBe(false);
      const [sql, params] = query.mock.calls[0];
      expect(String(sql)).toContain('optin_prompt_sent_at IS NULL');
      expect(params).toEqual(['discord', 'discord-user-1']);
    });

    it('releases the claim by writing NULL back to the marker', async () => {
      const execute = jest.fn().mockResolvedValue(undefined);
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute,
      };
      const repo = {
        query: jest.fn(),
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      } as unknown as Repository<DiscordAccountLinkEntity>;
      const service = new TypeormDiscordAccountLinkRepository(repo);

      await service.releaseConsentPrompt('discord-user-1');

      const setArg = qb.set.mock.calls[0][0] as Record<string, unknown>;
      expect(setArg['optinPromptSentAt']).toBeNull();
      expect(execute).toHaveBeenCalled();
    });
  });
});
