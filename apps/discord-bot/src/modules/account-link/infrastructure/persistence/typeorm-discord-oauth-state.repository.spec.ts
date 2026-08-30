/* eslint-disable @typescript-eslint/no-unsafe-assignment -- partial repo mocks */
import type { Repository } from 'typeorm';
import type { DiscordOauthStateEntity } from '@discord/infrastructure/database/entities/discord-oauth-state.entity';
import { TypeormDiscordOauthStateRepository } from './typeorm-discord-oauth-state.repository';

describe('TypeormDiscordOauthStateRepository (#428)', () => {
  function makeRepo() {
    return {
      save: jest.fn().mockResolvedValue(undefined),
      create: jest.fn((entity) => entity),
      query: jest.fn().mockResolvedValue([]),
    } as unknown as Repository<DiscordOauthStateEntity> & {
      save: jest.Mock;
      create: jest.Mock;
      query: jest.Mock;
    };
  }

  it('saveState persists state + encrypted link token + created date', async () => {
    const repo = makeRepo();
    const repository = new TypeormDiscordOauthStateRepository(repo);
    const createdAt = new Date('2026-08-30T00:00:00Z');

    await repository.saveState({
      state: 'state-1',
      encryptedLinkToken: 'v1.iv.tag.cipher',
      createdAt,
    });

    expect(repo.save).toHaveBeenCalledWith({
      state: 'state-1',
      linkToken: 'v1.iv.tag.cipher',
      createdAt,
    });
  });

  it('deleteByState consumes via a single atomic DELETE..RETURNING (no read-then-delete race)', async () => {
    const repo = makeRepo();
    repo.query.mockResolvedValue([
      { link_token: 'v1.iv.tag.cipher', created_at: '2026-08-30T00:00:00Z' },
    ]);
    const repository = new TypeormDiscordOauthStateRepository(repo);

    const row = await repository.deleteByState('state-1');

    expect(repo.query).toHaveBeenCalledTimes(1);
    const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM "discord_oauth_states"');
    expect(sql).toContain('RETURNING');
    expect(sql).not.toMatch(/^\s*SELECT/i);
    expect(params).toEqual(['state-1']);
    expect(row).toEqual({
      linkToken: 'v1.iv.tag.cipher',
      createdAt: new Date('2026-08-30T00:00:00Z'),
    });
  });

  it('deleteByState returns undefined when the state does not exist', async () => {
    const repo = makeRepo();
    repo.query.mockResolvedValue([]);
    const repository = new TypeormDiscordOauthStateRepository(repo);

    await expect(repository.deleteByState('unknown')).resolves.toBeUndefined();
  });

  it('deleteExpiredBefore deletes rows older than the cutoff, bounded', async () => {
    const repo = makeRepo();
    const repository = new TypeormDiscordOauthStateRepository(repo);
    const cutoff = new Date('2026-08-30T00:00:00Z');

    await repository.deleteExpiredBefore(cutoff, 100);

    const [sql, params] = repo.query.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('DELETE FROM "discord_oauth_states"');
    expect(sql).toContain('LIMIT');
    expect(params).toEqual([cutoff, 100]);
  });
});
