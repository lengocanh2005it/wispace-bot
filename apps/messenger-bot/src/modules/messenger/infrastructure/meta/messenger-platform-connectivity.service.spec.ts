import type { ConfigService } from '@nestjs/config';
import { PlatformConnectivityState } from '@wispace/bot-common/health';
import { MessengerPlatformConnectivityService } from './messenger-platform-connectivity.service';

function buildConfig(
  values: Record<string, string | undefined>,
): ConfigService {
  return {
    get: (key: string) => values[key],
  } as unknown as ConfigService;
}

describe('MessengerPlatformConnectivityService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
    jest.useRealTimers();
  });

  it('marks a missing page token unavailable without a vendor call', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    const state = new PlatformConnectivityState('messenger');
    const service = new MessengerPlatformConnectivityService(
      buildConfig({ NODE_ENV: 'test' }),
      state,
    );

    await (service as unknown as { validate(): Promise<void> }).validate();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.getSnapshot()).toMatchObject({
      status: 'unavailable',
      ready: false,
      reason: 'token_missing',
    });
  });

  it('marks the platform connected after read-only Graph validation', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response);
    const state = new PlatformConnectivityState('messenger');
    const service = new MessengerPlatformConnectivityService(
      buildConfig({
        NODE_ENV: 'test',
        PAGE_ACCESS_TOKEN: 'page-token',
        GRAPH_API_VERSION: 'v25.0',
      }),
      state,
    );

    await (service as unknown as { validate(): Promise<void> }).validate();
    expect(state.getSnapshot()).toMatchObject({
      status: 'connected',
      ready: true,
      reason: 'connected',
    });
  });

  it('marks a definite Graph credential rejection as terminal', async () => {
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
    } as Response);
    const state = new PlatformConnectivityState('messenger');
    const service = new MessengerPlatformConnectivityService(
      buildConfig({ PAGE_ACCESS_TOKEN: 'page-token' }),
      state,
    );

    await (service as unknown as { validate(): Promise<void> }).validate();
    expect(state.getSnapshot()).toMatchObject({
      status: 'credential_invalid',
      ready: false,
      reason: 'meta_token_rejected',
    });
  });

  it('expires a transient reconnect grace after the last verification becomes stale', async () => {
    jest.useFakeTimers();
    jest.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true,
      status: 200,
      statusText: 'OK',
    } as Response);
    const state = new PlatformConnectivityState('messenger');
    const service = new MessengerPlatformConnectivityService(
      buildConfig({
        PAGE_ACCESS_TOKEN: 'page-token',
        MESSENGER_PLATFORM_HEALTH_STALE_MS: '1000',
      }),
      state,
    );
    await (service as unknown as { validate(): Promise<void> }).validate();
    (globalThis.fetch as jest.Mock).mockRejectedValue(
      new Error('network down'),
    );
    await (service as unknown as { validate(): Promise<void> }).validate();
    expect(state.getSnapshot().ready).toBe(true);
    jest.advanceTimersByTime(1000);
    expect(state.getSnapshot()).toMatchObject({
      status: 'reconnecting',
      ready: false,
    });
  });
});
