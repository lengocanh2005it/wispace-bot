import { TypeormZaloOaTokenStoreAdapter } from './typeorm-zalo-oa-token-store.adapter';
import type { ZaloOaTokenSnapshot } from '../../application/ports/zalo-oa-token-store.port';

function buildRow(
  overrides: Partial<ZaloOaTokenSnapshot> = {},
): Record<string, unknown> {
  return {
    id: '1',
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    accessTokenExpiresAt: new Date('2026-09-10T15:00:00Z'),
    refreshTokenExpiresAt: new Date('2026-10-10T15:00:00Z'),
    updatedAt: new Date('2026-09-10T14:00:00Z'),
    version: 4,
    ...overrides,
  };
}

describe('TypeormZaloOaTokenStoreAdapter', () => {
  it('reads the latest token row as a plain application snapshot', async () => {
    const row = buildRow();
    const repo = {
      findOne: jest.fn().mockResolvedValue(row),
      manager: { transaction: jest.fn() },
    };
    const adapter = new TypeormZaloOaTokenStoreAdapter(repo as never);

    await expect(adapter.readCurrent()).resolves.toEqual(row);
    expect(repo.findOne).toHaveBeenCalledWith({
      where: {},
      order: { id: 'DESC' },
    });
  });

  it('locks, re-reads, refreshes, and persists the next single-use pair', async () => {
    const row = buildRow();
    const em = {
      findOne: jest.fn().mockResolvedValue(row),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const repo = {
      findOne: jest.fn(),
      manager: {
        transaction: jest.fn((callback: (manager: typeof em) => unknown) =>
          callback(em),
        ),
      },
    };
    const adapter = new TypeormZaloOaTokenStoreAdapter(repo as never);
    const next = {
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessTokenExpiresAt: new Date('2026-09-10T16:00:00Z'),
      refreshTokenExpiresAt: new Date('2026-11-10T15:00:00Z'),
    };

    await expect(
      adapter.refreshWithLock(async (current) => {
        expect(current.refreshToken).toBe('refresh-1');
        return next;
      }),
    ).resolves.toEqual(
      expect.objectContaining({
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        version: 5,
      }),
    );
    expect(em.findOne).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ lock: { mode: 'pessimistic_write' } }),
    );
    expect(em.update).toHaveBeenCalledWith(
      expect.anything(),
      { id: '1', version: 4 },
      expect.objectContaining({
        accessToken: 'access-2',
        refreshToken: 'refresh-2',
        version: 5,
      }),
    );
  });

  it('returns the locked row without writing when the policy callback skips refresh', async () => {
    const row = buildRow();
    const em = {
      findOne: jest.fn().mockResolvedValue(row),
      update: jest.fn(),
    };
    const repo = {
      findOne: jest.fn(),
      manager: {
        transaction: jest.fn((callback: (manager: typeof em) => unknown) =>
          callback(em),
        ),
      },
    };
    const adapter = new TypeormZaloOaTokenStoreAdapter(repo as never);

    await expect(
      adapter.refreshWithLock(async () => undefined),
    ).resolves.toEqual(
      expect.objectContaining({ accessToken: 'access-1', version: 4 }),
    );
    expect(em.update).not.toHaveBeenCalled();
  });

  it('returns undefined when bootstrap has not created a row', async () => {
    const em = { findOne: jest.fn().mockResolvedValue(null) };
    const repo = {
      findOne: jest.fn(),
      manager: {
        transaction: jest.fn((callback: (manager: typeof em) => unknown) =>
          callback(em),
        ),
      },
    };
    const adapter = new TypeormZaloOaTokenStoreAdapter(repo as never);

    await expect(adapter.refreshWithLock(async () => undefined)).resolves.toBe(
      undefined,
    );
  });
});
