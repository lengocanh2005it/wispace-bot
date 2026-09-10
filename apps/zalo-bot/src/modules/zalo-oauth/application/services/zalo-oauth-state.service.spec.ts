import { ZaloOauthStateService } from './zalo-oauth-state.service';
import type {
  ZaloOauthStateRecord,
  ZaloOauthStateStorePort,
} from '../ports/zalo-oauth-state-store.port';

function buildStore(
  overrides: Partial<ZaloOauthStateStorePort> = {},
): ZaloOauthStateStorePort {
  return {
    save: jest.fn().mockResolvedValue(undefined),
    consume: jest.fn(),
    cleanupExpired: jest.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe('ZaloOauthStateService', () => {
  it('creates a state and delegates plaintext values to the encrypted store', async () => {
    const store = buildStore();
    const service = new ZaloOauthStateService(store);

    const state = await service.create('verifier-123', 'link-token-123');

    expect(state.length).toBeGreaterThan(10);
    expect(store.save).toHaveBeenCalledWith(
      expect.objectContaining({
        state,
        codeVerifier: 'verifier-123',
        linkToken: 'link-token-123',
        createdAt: expect.any(Date),
      }),
    );
    expect(store.cleanupExpired).toHaveBeenCalledWith(expect.any(Date), 100);
  });

  it('keeps creating a state when opportunistic cleanup fails', async () => {
    const store = buildStore({
      cleanupExpired: jest.fn().mockRejectedValue(new Error('db down')),
    });
    const service = new ZaloOauthStateService(store);

    const state = await service.create('verifier-123', 'link-token-123');

    expect(state.length).toBeGreaterThan(10);
    expect(store.save).toHaveBeenCalledTimes(1);
  });

  it('consumes a fresh state and enforces single-use through the store', async () => {
    const record: ZaloOauthStateRecord = {
      state: 'state-1',
      codeVerifier: 'verifier-123',
      linkToken: 'link-token-123',
      createdAt: new Date(),
    };
    const store = buildStore({
      consume: jest.fn().mockResolvedValue(record),
    });
    const service = new ZaloOauthStateService(store);

    await expect(service.consume('state-1')).resolves.toEqual({
      codeVerifier: 'verifier-123',
      linkToken: 'link-token-123',
    });
    expect(store.consume).toHaveBeenCalledWith('state-1');
  });

  it('returns undefined for an expired state', async () => {
    const store = buildStore({
      consume: jest.fn().mockResolvedValue({
        state: 'state-1',
        codeVerifier: 'verifier-123',
        linkToken: 'link-token-123',
        createdAt: new Date(Date.now() - 11 * 60 * 1000),
      }),
    });
    const service = new ZaloOauthStateService(store);

    await expect(service.consume('state-1')).resolves.toBeUndefined();
  });

  it('fails closed for missing or malformed persisted state', async () => {
    const store = buildStore({
      consume: jest
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce({
          state: 'state-2',
          codeVerifier: 'verifier',
          linkToken: 'token',
          createdAt: new Date(Number.NaN),
        }),
    });
    const service = new ZaloOauthStateService(store);

    await expect(service.consume('missing')).resolves.toBeUndefined();
    await expect(service.consume('state-2')).resolves.toBeUndefined();
  });
});
