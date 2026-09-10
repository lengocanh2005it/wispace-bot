/* eslint-disable @typescript-eslint/unbound-method -- Jest mock method assertions */
import type { BotMetricsService } from '@wispace/bot-metrics';
import type { ZaloOAuthClientPort } from '../ports/zalo-oauth-client.port';
import type {
  ZaloOaTokenPair,
  ZaloOaTokenSnapshot,
  ZaloOaTokenStorePort,
} from '../ports/zalo-oa-token-store.port';
import { ZaloTokenService } from './zalo-token.service';

function buildRow(
  overrides: Partial<ZaloOaTokenSnapshot> = {},
): ZaloOaTokenSnapshot {
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

function buildPair(): ZaloOaTokenPair {
  return {
    accessToken: 'new-access-token',
    refreshToken: 'new-refresh-token',
    accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
    refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
  };
}

function buildStore(
  overrides: Partial<ZaloOaTokenStorePort> = {},
): ZaloOaTokenStorePort {
  return {
    readCurrent: jest.fn().mockResolvedValue(buildRow()),
    refreshWithLock: jest
      .fn()
      .mockImplementation(async (refresh) => refresh(buildRow())),
    ...overrides,
  };
}

function buildOAuth(
  overrides: Partial<ZaloOAuthClientPort> = {},
): ZaloOAuthClientPort {
  return {
    exchangeCodeForUser: jest.fn(),
    refreshOaToken: jest.fn().mockResolvedValue(buildPair()),
    ...overrides,
  };
}

describe('ZaloTokenService', () => {
  it('returns the stored access_token when still valid (no lock, no refresh)', async () => {
    const tokenStore = buildStore();
    const oauth = buildOAuth();
    const service = new ZaloTokenService(tokenStore, oauth);

    await expect(service.getValidAccessToken()).resolves.toBe('valid-token');
    expect(tokenStore.refreshWithLock).not.toHaveBeenCalled();
    expect(oauth.refreshOaToken).not.toHaveBeenCalled();
  });

  it('refreshes through the serialized store and persists the new pair', async () => {
    const expiredRow = buildRow({
      accessToken: 'stale-token',
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
    const refreshed = buildRow({ ...buildPair(), version: 1 });
    const tokenStore = buildStore({
      readCurrent: jest.fn().mockResolvedValue(expiredRow),
      refreshWithLock: jest.fn().mockImplementation(async (refresh) => {
        await refresh(expiredRow);
        return refreshed;
      }),
    });
    const oauth = buildOAuth();
    const service = new ZaloTokenService(tokenStore, oauth);

    await expect(service.getValidAccessToken()).resolves.toBe(
      'new-access-token',
    );
    expect(oauth.refreshOaToken).toHaveBeenCalledWith('refresh-1');
    expect(tokenStore.refreshWithLock).toHaveBeenCalledTimes(1);
  });

  it('skips the refresh when the row is already fresh after the lock (other worker won)', async () => {
    const freshRow = buildRow();
    const tokenStore = buildStore({
      readCurrent: jest
        .fn()
        .mockResolvedValue(
          buildRow({ accessTokenExpiresAt: new Date(Date.now() - 1000) }),
        ),
      refreshWithLock: jest.fn().mockImplementation(async (refresh) => {
        await refresh(freshRow);
        return freshRow;
      }),
    });
    const oauth = buildOAuth();
    const service = new ZaloTokenService(tokenStore, oauth);

    await expect(service.getValidAccessToken()).resolves.toBe('valid-token');
    expect(oauth.refreshOaToken).not.toHaveBeenCalled();
  });

  it('re-reads the persisted row between retries instead of a stale snapshot', async () => {
    const expiredRow = buildRow({
      accessToken: 'stale-token',
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
    const freshRow = buildRow({ accessToken: 'fresh-after-other-worker' });
    let calls = 0;
    const refreshWithLock = jest.fn().mockImplementation(async (refresh) => {
      calls += 1;
      if (calls === 1) {
        await refresh(expiredRow);
        throw new Error('persist failed');
      }
      return freshRow;
    });
    const tokenStore = buildStore({
      readCurrent: jest.fn().mockResolvedValue(expiredRow),
      refreshWithLock,
    });
    const oauth = buildOAuth();
    const service = new ZaloTokenService(tokenStore, oauth);
    const timeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
    ) => {
      callback();
      return {} as NodeJS.Timeout;
    }) as typeof setTimeout);

    await expect(service.getValidAccessToken()).resolves.toBe(
      'fresh-after-other-worker',
    );
    expect(oauth.refreshOaToken).toHaveBeenCalledTimes(1);
    expect(refreshWithLock).toHaveBeenCalledTimes(2);
    timeoutSpy.mockRestore();
  });

  it('throws when no token row exists (bootstrap not done)', async () => {
    const tokenStore = buildStore({
      readCurrent: jest.fn().mockResolvedValue(undefined),
      refreshWithLock: jest.fn(),
    });
    const service = new ZaloTokenService(tokenStore, buildOAuth());

    await expect(service.getValidAccessToken()).rejects.toThrow(
      'zalo_oa_tokens is empty',
    );
    expect(tokenStore.refreshWithLock).not.toHaveBeenCalled();
  });

  it('records each missing-token refresh failure', async () => {
    const tokenStore = buildStore({
      readCurrent: jest.fn().mockResolvedValue(undefined),
      refreshWithLock: jest.fn(),
    });
    const metrics = {
      incTokenRefreshFailure: jest.fn(),
    } as unknown as BotMetricsService;
    const service = new ZaloTokenService(
      tokenStore,
      buildOAuth(),
      undefined,
      metrics,
    );

    await expect(service.getValidAccessToken()).rejects.toThrow(
      'zalo_oa_tokens is empty',
    );
    await expect(service.getValidAccessToken()).rejects.toThrow(
      'zalo_oa_tokens is empty',
    );
    expect(metrics.incTokenRefreshFailure).toHaveBeenCalledTimes(2);
    expect(metrics.incTokenRefreshFailure).toHaveBeenCalledWith('missing');
  });

  it('records a rejected refresh with a bounded reason', async () => {
    const expiredRow = buildRow({
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
    const tokenStore = buildStore({
      readCurrent: jest.fn().mockResolvedValue(expiredRow),
      refreshWithLock: jest
        .fn()
        .mockImplementation(async (refresh) => refresh(expiredRow)),
    });
    const oauth = buildOAuth({
      refreshOaToken: jest
        .fn()
        .mockRejectedValue(new Error('Zalo OA token refresh failed: HTTP 401')),
    });
    const metrics = {
      incTokenRefreshFailure: jest.fn(),
    } as unknown as BotMetricsService;
    const setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((
      callback: (...args: unknown[]) => void,
    ) => {
      callback();
      return {} as NodeJS.Timeout;
    }) as typeof setTimeout);
    const service = new ZaloTokenService(tokenStore, oauth, undefined, metrics);

    await expect(service.getValidAccessToken()).rejects.toThrow(
      'refresh failed after',
    );
    expect(metrics.incTokenRefreshFailure).toHaveBeenCalledWith('rejected');
    setTimeoutSpy.mockRestore();
  });

  it('refreshNow skips when the table is empty', async () => {
    const tokenStore = buildStore({
      refreshWithLock: jest.fn().mockResolvedValue(undefined),
    });
    const service = new ZaloTokenService(tokenStore, buildOAuth());

    await expect(service.refreshNow()).resolves.toBeUndefined();
    expect(tokenStore.refreshWithLock).toHaveBeenCalledTimes(1);
  });

  it('refreshNow refreshes the pair', async () => {
    const expiredRow = buildRow({
      accessToken: 'stale-token',
      accessTokenExpiresAt: new Date(Date.now() - 1000),
    });
    const oauth = buildOAuth();
    const tokenStore = buildStore({
      refreshWithLock: jest.fn().mockImplementation(async (refresh) => {
        const next = await refresh(expiredRow);
        return { ...expiredRow, ...next, version: 1 };
      }),
    });
    const service = new ZaloTokenService(tokenStore, oauth);

    await service.refreshNow();
    expect(tokenStore.refreshWithLock).toHaveBeenCalledTimes(1);
    expect(oauth.refreshOaToken).toHaveBeenCalledWith('refresh-1');
  });
});
