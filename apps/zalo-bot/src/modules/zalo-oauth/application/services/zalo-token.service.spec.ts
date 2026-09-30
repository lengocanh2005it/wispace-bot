import { PlatformConnectivityState } from '@wispace/bot-common/health';
import type { ConfigService } from '@nestjs/config';
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

function buildConfig(values: Record<string, string>): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
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
  it('reports not_configured when no Zalo OA account was ever provisioned', async () => {
    // The token row is empty AND there are no OA app credentials, so this
    // deployment never had a Zalo account. That is not an outage.
    const state = new PlatformConnectivityState('zalo');
    const service = new ZaloTokenService(
      buildStore({
        readCurrent: jest.fn().mockResolvedValue(null),
      }),
      buildOAuth(),
      state,
      undefined,
      buildConfig({}),
    );

    await service.refreshNow();

    expect(state.getSnapshot()).toMatchObject({
      status: 'not_configured',
      reason: 'not_configured',
      ready: false,
    });
  });

  it('still reports token_missing when an OA account exists but its row is gone', async () => {
    // Credentials are provisioned, so an empty token row is real data loss and
    // must keep failing readiness.
    const state = new PlatformConnectivityState('zalo');
    const service = new ZaloTokenService(
      buildStore({
        readCurrent: jest.fn().mockResolvedValue(null),
      }),
      buildOAuth(),
      state,
      undefined,
      buildConfig({ ZALO_APP_ID: '1234', ZALO_APP_SECRET_KEY: 'secret' }),
    );

    await service.refreshNow();

    expect(state.getSnapshot()).toMatchObject({
      status: 'unavailable',
      reason: 'token_missing',
      ready: false,
    });
  });

  it('reports not_configured when the platform is explicitly switched off', async () => {
    // Stale placeholder credentials are present, so their presence cannot be
    // used to infer whether the platform is in use. The operator says so.
    const state = new PlatformConnectivityState('zalo');
    const service = new ZaloTokenService(
      buildStore({ readCurrent: jest.fn().mockResolvedValue(null) }),
      buildOAuth(),
      state,
      undefined,
      buildConfig({
        ZALO_APP_ID: '1234',
        ZALO_APP_SECRET_KEY: 'stale-placeholder',
        ZALO_PLATFORM_ENABLED: 'false',
      }),
    );

    await service.refreshNow();

    expect(state.getSnapshot()).toMatchObject({
      status: 'not_configured',
      reason: 'not_configured',
    });
  });

  it('keeps failing when the platform is on but no flag was ever set', async () => {
    // Absent flag must not relax readiness, or a real deployment that forgot
    // the flag would silently report healthy.
    const state = new PlatformConnectivityState('zalo');
    const service = new ZaloTokenService(
      buildStore({ readCurrent: jest.fn().mockResolvedValue(null) }),
      buildOAuth(),
      state,
      undefined,
      buildConfig({ ZALO_APP_ID: '1234', ZALO_APP_SECRET_KEY: 'secret' }),
    );

    await service.refreshNow();

    expect(state.getSnapshot()).toMatchObject({
      status: 'unavailable',
      reason: 'token_missing',
    });
  });

  it('reports not_configured from the startup probe, not only the cron', async () => {
    // onModuleInit is what sets the readiness state the deploy reads. A guard
    // applied only to refreshNow never runs on this path, which is how the
    // first attempt at this fix failed to change production behaviour.
    const state = new PlatformConnectivityState('zalo');
    const service = new ZaloTokenService(
      buildStore({ readCurrent: jest.fn().mockResolvedValue(null) }),
      buildOAuth(),
      state,
      undefined,
      buildConfig({
        ZALO_APP_ID: '1234',
        ZALO_APP_SECRET_KEY: 'stale-placeholder',
        ZALO_PLATFORM_ENABLED: 'false',
      }),
    );

    await service.onModuleInit();
    await new Promise((r) => setImmediate(r));

    expect(state.getSnapshot()).toMatchObject({
      status: 'not_configured',
      reason: 'not_configured',
    });
  });

  it('reports not_configured even when the token row exists and refresh fails', async () => {
    // The real production shape: an expired row plus stale placeholder
    // credentials, so the refresh fails rather than reporting a missing row.
    const state = new PlatformConnectivityState('zalo');
    const oauth = buildOAuth();
    oauth.refreshOaToken = jest
      .fn()
      .mockRejectedValue(new Error('network unreachable'));
    const service = new ZaloTokenService(
      buildStore({
        readCurrent: jest
          .fn()
          .mockResolvedValue(buildRow({ accessTokenExpiresAt: new Date(0) })),
        refreshWithLock: jest.fn().mockImplementation(async (refresh) => {
          void refresh;
          throw new Error('network unreachable');
        }),
      }),
      oauth,
      state,
      undefined,
      buildConfig({
        ZALO_APP_ID: '1234',
        ZALO_APP_SECRET_KEY: 'stale-placeholder',
        ZALO_PLATFORM_ENABLED: 'false',
      }),
    );

    await service.refreshNow().catch(() => undefined);

    expect(state.getSnapshot()).toMatchObject({
      status: 'not_configured',
      reason: 'not_configured',
    });
  });
});
