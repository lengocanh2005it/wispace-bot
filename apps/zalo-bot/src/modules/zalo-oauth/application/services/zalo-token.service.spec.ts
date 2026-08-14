/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { ZaloTokenService } from './zalo-token.service';
import { ZaloOaTokenEntity } from '@zalo/infrastructure/database/entities/zalo-oa-token.entity';

function buildConfig(): ConfigService {
  return {
    getOrThrow: (key: string) =>
      ({ ZALO_APP_ID: 'app-1', ZALO_APP_SECRET_KEY: 'secret-1' })[key],
  } as unknown as ConfigService;
}

interface RowOverrides {
  accessToken?: string;
  refreshToken?: string;
  accessTokenExpiresAt?: Date;
}

function buildRow(overrides: RowOverrides = {}): ZaloOaTokenEntity {
  return {
    id: '1',
    accessToken: 'valid-token',
    refreshToken: 'refresh-1',
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    updatedAt: new Date(),
    version: 0,
    ...overrides,
  };
}

function buildFetchMock(ok = true): jest.Mock {
  return jest.fn().mockResolvedValue({
    ok,
    json: () =>
      Promise.resolve({
        access_token: 'new-access-token',
        refresh_token: 'new-refresh-token',
        expires_in: '3600',
        refresh_token_expires_in: '2592000',
      }),
  });
}

function buildTransactionManager(em: {
  findOne: jest.Mock;
  update: jest.Mock;
}) {
  return jest.fn((fn: (manager: typeof em) => unknown) => fn(em));
}

describe('ZaloTokenService', () => {
  afterEach(() => {
    delete (global as { fetch?: unknown }).fetch;
  });

  it('returns the stored access_token when still valid (no lock, no refresh)', async () => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(buildRow()),
      manager: { transaction: jest.fn() },
    } as unknown as Repository<ZaloOaTokenEntity>;

    const service = new ZaloTokenService(buildConfig(), repo);

    await expect(service.getValidAccessToken()).resolves.toBe('valid-token');
    expect(repo.manager.transaction).not.toHaveBeenCalled();
  });

  it('refreshes under a pessimistic row lock and persists the new pair', async () => {
    const expiredRow = buildRow({
      accessToken: 'stale-token',
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
    const em = {
      findOne: jest.fn().mockResolvedValue(expiredRow),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const repo = {
      findOne: jest.fn().mockResolvedValue(expiredRow),
      manager: { transaction: buildTransactionManager(em) },
    } as unknown as Repository<ZaloOaTokenEntity>;

    const fetchMock = buildFetchMock();
    global.fetch = fetchMock;

    const service = new ZaloTokenService(buildConfig(), repo);

    const token = await service.getValidAccessToken();

    expect(token).toBe('new-access-token');
    expect(em.findOne).toHaveBeenCalledWith(
      ZaloOaTokenEntity,
      expect.objectContaining({
        lock: { mode: 'pessimistic_write' },
      }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://oauth.zaloapp.com/v4/access_token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(em.update).toHaveBeenCalledWith(
      ZaloOaTokenEntity,
      { id: '1', version: 0 },
      expect.objectContaining({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
        version: 1,
      }),
    );
  });

  it('skips the refresh when the row is already fresh after the lock (other worker won)', async () => {
    const em = {
      findOne: jest.fn().mockResolvedValue(buildRow()),
      update: jest.fn(),
    };
    const repo = {
      findOne: jest
        .fn()
        .mockResolvedValue(
          buildRow({ accessTokenExpiresAt: new Date(Date.now() - 1000) }),
        ),
      manager: { transaction: buildTransactionManager(em) },
    } as unknown as Repository<ZaloOaTokenEntity>;

    const fetchMock = buildFetchMock();
    global.fetch = fetchMock;

    const service = new ZaloTokenService(buildConfig(), repo);

    await expect(service.getValidAccessToken()).resolves.toBe('valid-token');
    expect(fetchMock).not.toHaveBeenCalled();
    expect(em.update).not.toHaveBeenCalled();
  });

  it('re-reads the persisted row between retries instead of a stale snapshot', async () => {
    const expiredRow = buildRow({
      accessToken: 'stale-token',
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
    const freshRow = buildRow({ accessToken: 'fresh-after-other-worker' });

    let findOneCalls = 0;
    const em = {
      findOne: jest.fn().mockImplementation(() => {
        findOneCalls += 1;
        return Promise.resolve(findOneCalls === 1 ? expiredRow : freshRow);
      }),
      update: jest.fn().mockRejectedValue(new Error('persist failed')),
    };
    const repo = {
      findOne: jest.fn().mockResolvedValue(expiredRow),
      manager: { transaction: buildTransactionManager(em) },
    } as unknown as Repository<ZaloOaTokenEntity>;

    const fetchMock = buildFetchMock();
    global.fetch = fetchMock;

    const service = new ZaloTokenService(buildConfig(), repo);

    const token = await service.getValidAccessToken();

    expect(token).toBe('fresh-after-other-worker');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(repo.manager.transaction).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('throws when no token row exists (bootstrap not done)', async () => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      manager: { transaction: jest.fn() },
    } as unknown as Repository<ZaloOaTokenEntity>;

    const service = new ZaloTokenService(buildConfig(), repo);

    await expect(service.getValidAccessToken()).rejects.toThrow(
      'zalo_oa_tokens is empty',
    );
    expect(repo.manager.transaction).not.toHaveBeenCalled();
  });

  it('refreshNow skips (warns) when the table is empty', async () => {
    const warn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => undefined);
    const em = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    };
    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      manager: { transaction: buildTransactionManager(em) },
    } as unknown as Repository<ZaloOaTokenEntity>;

    const service = new ZaloTokenService(buildConfig(), repo);

    await expect(service.refreshNow()).resolves.toBeUndefined();
    expect(repo.manager.transaction).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('refreshNow refreshes the pair', async () => {
    const expiredRow = buildRow({
      accessToken: 'stale-token',
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
    const em = {
      findOne: jest.fn().mockResolvedValue(expiredRow),
      update: jest.fn().mockResolvedValue(undefined),
    };
    const repo = {
      findOne: jest.fn().mockResolvedValue(expiredRow),
      manager: { transaction: buildTransactionManager(em) },
    } as unknown as Repository<ZaloOaTokenEntity>;

    const fetchMock = buildFetchMock();
    global.fetch = fetchMock;

    const service = new ZaloTokenService(buildConfig(), repo);

    await service.refreshNow();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(em.update).toHaveBeenCalled();
  });

  it.each([
    'missing expires_in (NaN dates)',
    'missing refresh_token',
    'empty access_token',
  ])(
    'rejects a 200 response with an invalid payload: %s — never persists NaN dates',
    async (caseName) => {
      const payloads: Record<string, unknown> = {
        'missing expires_in (NaN dates)': {
          access_token: 'tok',
          refresh_token: 'ref',
          refresh_token_expires_in: '2592000',
        },
        'missing refresh_token': {
          access_token: 'tok',
          expires_in: '3600',
          refresh_token_expires_in: '2592000',
        },
        'empty access_token': {
          access_token: '',
          refresh_token: 'ref',
          expires_in: '3600',
          refresh_token_expires_in: '2592000',
        },
      };

      const expiredRow = buildRow({
        accessToken: 'stale-token',
        accessTokenExpiresAt: new Date(Date.now() - 1000),
      });
      const em = {
        findOne: jest.fn().mockResolvedValue(expiredRow),
        update: jest.fn().mockResolvedValue(undefined),
      };
      const repo = {
        findOne: jest.fn().mockResolvedValue(expiredRow),
        manager: { transaction: buildTransactionManager(em) },
      } as unknown as Repository<ZaloOaTokenEntity>;

      global.fetch = jest.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(payloads[caseName]),
      });

      const service = new ZaloTokenService(buildConfig(), repo);

      await expect(service.getValidAccessToken()).rejects.toThrow(
        'invalid payload',
      );
      expect(em.update).not.toHaveBeenCalled();
    },
  );
});
