import type { Repository } from 'typeorm';
import { ZaloOauthStateService } from './zalo-oauth-state.service';
import { ZaloOauthStateEntity } from '../../../../infrastructure/database/entities/zalo-oauth-state.entity';

function buildRepo(overrides: Partial<Repository<ZaloOauthStateEntity>> = {}) {
  return {
    save: jest.fn(),
    findOne: jest.fn(),
    delete: jest.fn(),
    ...overrides,
  } as unknown as Repository<ZaloOauthStateEntity>;
}

describe('ZaloOauthStateService', () => {
  it('creates a state row and returns a non-empty state string', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloOauthStateService(buildRepo({ save }));

    const state = await service.create('verifier-123');

    expect(state.length).toBeGreaterThan(10);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({ state, codeVerifier: 'verifier-123' }),
    );
  });

  it('consumes a fresh state and deletes it', async () => {
    const row = {
      state: 'state-1',
      codeVerifier: 'verifier-123',
      createdAt: new Date(),
    };
    const findOne = jest.fn().mockResolvedValue(row);
    const del = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloOauthStateService(
      buildRepo({ findOne, delete: del }),
    );

    const codeVerifier = await service.consume('state-1');

    expect(codeVerifier).toBe('verifier-123');
    expect(del).toHaveBeenCalledWith({ state: 'state-1' });
  });

  it('returns undefined for an expired state (older than 10 minutes)', async () => {
    const row = {
      state: 'state-1',
      codeVerifier: 'verifier-123',
      createdAt: new Date(Date.now() - 11 * 60 * 1000),
    };
    const findOne = jest.fn().mockResolvedValue(row);
    const del = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloOauthStateService(
      buildRepo({ findOne, delete: del }),
    );

    const codeVerifier = await service.consume('state-1');

    expect(codeVerifier).toBeUndefined();
    expect(del).toHaveBeenCalledWith({ state: 'state-1' });
  });

  it('returns undefined when the state does not exist', async () => {
    const findOne = jest.fn().mockResolvedValue(null);
    const service = new ZaloOauthStateService(buildRepo({ findOne }));

    await expect(service.consume('missing')).resolves.toBeUndefined();
  });
});
