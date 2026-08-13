import type { Repository } from 'typeorm';
import { ZaloOauthStateService } from './zalo-oauth-state.service';
import { ZaloOauthStateEntity } from '@zalo/infrastructure/database/entities/zalo-oauth-state.entity';

function buildRepo(overrides: Partial<Repository<ZaloOauthStateEntity>> = {}) {
  return {
    save: jest.fn(),
    query: jest.fn(),
    ...overrides,
  } as unknown as Repository<ZaloOauthStateEntity>;
}

describe('ZaloOauthStateService', () => {
  it('creates a state row and returns a non-empty state string', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloOauthStateService(buildRepo({ save }));

    const state = await service.create('verifier-123', 'link-token-123');

    expect(state.length).toBeGreaterThan(10);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        state,
        codeVerifier: 'verifier-123',
        linkToken: 'link-token-123',
      }),
    );
  });

  it('atomically consumes a fresh state so concurrent callbacks cannot reuse it', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        code_verifier: 'verifier-123',
        link_token: 'link-token-123',
        created_at: new Date(),
      },
    ]);
    const service = new ZaloOauthStateService(buildRepo({ query }));

    const consumed = await service.consume('state-1');

    expect(consumed).toEqual({
      codeVerifier: 'verifier-123',
      linkToken: 'link-token-123',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM "zalo_oauth_states"'),
      ['state-1'],
    );
  });

  it('returns undefined for an expired state (older than 10 minutes)', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        code_verifier: 'verifier-123',
        link_token: 'link-token-123',
        created_at: new Date(Date.now() - 11 * 60 * 1000),
      },
    ]);
    const service = new ZaloOauthStateService(buildRepo({ query }));

    const codeVerifier = await service.consume('state-1');

    expect(codeVerifier).toBeUndefined();
  });

  it('returns undefined when the state does not exist', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new ZaloOauthStateService(buildRepo({ query }));

    await expect(service.consume('missing')).resolves.toBeUndefined();
  });
});
