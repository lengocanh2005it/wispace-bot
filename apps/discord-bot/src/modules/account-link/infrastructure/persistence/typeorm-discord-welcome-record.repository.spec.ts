/* eslint-disable @typescript-eslint/no-unsafe-assignment -- partial repo mocks */
import type { Repository } from 'typeorm';
import type { DiscordWelcomeRecordEntity } from '@discord/infrastructure/database/entities/discord-welcome-record.entity';
import { TypeormDiscordWelcomeRecordRepository } from './typeorm-discord-welcome-record.repository';

describe('TypeormDiscordWelcomeRecordRepository (#231/#233)', () => {
  it('markWelcomed upserts by discord user id alone with the source', async () => {
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
      },
      ['discordUserId'],
    );
  });

  it('shouldWelcome returns true when never welcomed (no row / NULL)', async () => {
    const findOne = jest.fn().mockResolvedValue({ lastWelcomedAt: null });
    const repo = {
      findOne,
    } as unknown as Repository<DiscordWelcomeRecordEntity>;
    const service = new TypeormDiscordWelcomeRecordRepository(repo);

    await expect(
      service.shouldWelcome('discord-user-1', 86_400_000),
    ).resolves.toBe(true);
  });

  it('shouldWelcome returns false within the window', async () => {
    const findOne = jest.fn().mockResolvedValue({ lastWelcomedAt: new Date() });
    const repo = {
      findOne,
    } as unknown as Repository<DiscordWelcomeRecordEntity>;
    const service = new TypeormDiscordWelcomeRecordRepository(repo);

    await expect(
      service.shouldWelcome('discord-user-1', 86_400_000),
    ).resolves.toBe(false);
  });

  it('shouldWelcome returns true again after the window (rotating re-welcome)', async () => {
    const findOne = jest.fn().mockResolvedValue({
      lastWelcomedAt: new Date(Date.now() - 2 * 86_400_000),
    });
    const repo = {
      findOne,
    } as unknown as Repository<DiscordWelcomeRecordEntity>;
    const service = new TypeormDiscordWelcomeRecordRepository(repo);

    await expect(
      service.shouldWelcome('discord-user-1', 86_400_000),
    ).resolves.toBe(true);
  });
});
