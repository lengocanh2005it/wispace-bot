import type { Repository } from 'typeorm';
import type { DiscordAccountLinkEntity } from '@discord/infrastructure/database/entities/discord-account-link.entity';
import { TypeormDiscordAccountLinkRepository } from './typeorm-discord-account-link.repository';

describe('TypeormDiscordAccountLinkRepository', () => {
  it('upserts via transaction: detects existing mapping, deletes old link then inserts', async () => {
    const query = jest.fn().mockResolvedValue([]);
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
      expect.stringContaining('SELECT user_id FROM discord_account_links'),
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
      ['discord', 'discord-user-1', 143],
    );
    expect(result).toEqual({ relinked: false });
  });

  it('#137: reports relinked + the displaced userId when the Discord id moves to another WISPACE user', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ user_id: 99 }])
      .mockResolvedValue([]);
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
});
