/* eslint-disable @typescript-eslint/no-unsafe-assignment -- partial repo mocks */
import type { Repository } from 'typeorm';
import type { DiscordWelcomeRecordEntity } from '@discord/infrastructure/database/entities/discord-welcome-record.entity';
import { TypeormDiscordWelcomeRecordRepository } from './typeorm-discord-welcome-record.repository';

describe('TypeormDiscordWelcomeRecordRepository (#231/#233/#159)', () => {
  it('markWelcomed upserts by discord user id alone with the source and clears the claim', async () => {
    const upsert = jest.fn().mockResolvedValue({ identifiers: [] });
    const repo = {
      upsert,
    } as unknown as Repository<DiscordWelcomeRecordEntity>;
    const service = new TypeormDiscordWelcomeRecordRepository(repo);

    await service.markWelcomed('discord-user-1', 'organic');

    expect(upsert).toHaveBeenCalledWith(
      {
        discordUserId: 'discord-user-1',
        lastWelcomedAt: expect.any(Date),
        source: 'organic',
        claimExpiresAt: null,
      },
      ['discordUserId'],
    );
  });

  it('#159: tryClaimWelcome wins with a conditional upsert when never welcomed', async () => {
    const query = jest
      .fn()
      .mockResolvedValue([{ discord_user_id: 'discord-user-1' }]);
    const repo = {
      manager: { query },
    } as unknown as Repository<DiscordWelcomeRecordEntity>;
    const service = new TypeormDiscordWelcomeRecordRepository(repo);

    await expect(
      service.tryClaimWelcome('discord-user-1', 86_400_000, 60_000),
    ).resolves.toBe(true);

    const [sql, params] = query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO discord_welcome_records');
    expect(sql).toContain('ON CONFLICT (discord_user_id)');
    expect(sql).toContain('claim_expires_at < now()');
    expect(sql).toContain('RETURNING discord_user_id');
    expect(params).toEqual(['discord-user-1', 60_000, 86_400_000]);
  });

  it('#159: tryClaimWelcome loses (no duplicate) when welcomed within the window', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const repo = {
      manager: { query },
    } as unknown as Repository<DiscordWelcomeRecordEntity>;
    const service = new TypeormDiscordWelcomeRecordRepository(repo);

    await expect(
      service.tryClaimWelcome('discord-user-1', 86_400_000, 60_000),
    ).resolves.toBe(false);
  });

  it('#159: tryClaimWelcome wins again after the window expires (rotating re-welcome)', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ discord_user_id: 'discord-user-1' }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ discord_user_id: 'discord-user-1' }]);
    const repo = {
      manager: { query },
    } as unknown as Repository<DiscordWelcomeRecordEntity>;
    const service = new TypeormDiscordWelcomeRecordRepository(repo);

    // The SQL predicate decides by timestamps; the mock simulates the three
    // claim outcomes (won / within window / won after window).
    await expect(
      service.tryClaimWelcome('discord-user-1', 86_400_000, 60_000),
    ).resolves.toBe(true);
    await expect(
      service.tryClaimWelcome('discord-user-1', 86_400_000, 60_000),
    ).resolves.toBe(false);
    await expect(
      service.tryClaimWelcome('discord-user-1', 86_400_000, 60_000),
    ).resolves.toBe(true);
  });
});
