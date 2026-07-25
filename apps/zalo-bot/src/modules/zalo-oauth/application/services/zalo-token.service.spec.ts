import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { ZaloTokenService } from './zalo-token.service';
import { ZaloOaTokenEntity } from '../../../../infrastructure/database/entities/zalo-oa-token.entity';

function buildConfig(): ConfigService {
  return {
    getOrThrow: (key: string) =>
      ({ ZALO_APP_ID: 'app-1', ZALO_APP_SECRET_KEY: 'secret-1' })[key],
  } as unknown as ConfigService;
}

describe('ZaloTokenService', () => {
  it('returns the stored access_token when still valid', async () => {
    const row = {
      id: '1',
      accessToken: 'valid-token',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: new Date(Date.now() + 60 * 60 * 1000),
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    };
    const repoUpdate = jest.fn();
    const repo = {
      findOne: jest.fn().mockResolvedValue(row),
      update: repoUpdate,
    } as unknown as Repository<ZaloOaTokenEntity>;

    const service = new ZaloTokenService(buildConfig(), repo, {
      fetch: jest.fn(),
    });

    await expect(service.getValidAccessToken()).resolves.toBe('valid-token');
    expect(repoUpdate).not.toHaveBeenCalled();
  });

  it('refreshes and persists a new token pair when access_token is expired', async () => {
    const row = {
      id: '1',
      accessToken: 'stale-token',
      refreshToken: 'refresh-1',
      accessTokenExpiresAt: new Date(Date.now() - 1000),
      refreshTokenExpiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
      updatedAt: new Date(),
    };
    const repoUpdate = jest.fn().mockResolvedValue(undefined);
    const repo = {
      findOne: jest.fn().mockResolvedValue(row),
      update: repoUpdate,
    } as unknown as Repository<ZaloOaTokenEntity>;

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          access_token: 'new-access-token',
          refresh_token: 'new-refresh-token',
          expires_in: '3600',
          refresh_token_expires_in: '2592000',
        }),
    });

    const service = new ZaloTokenService(buildConfig(), repo, {
      fetch: fetchMock,
    });

    const token = await service.getValidAccessToken();

    expect(token).toBe('new-access-token');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://oauth.zaloapp.com/v4/access_token',
      expect.objectContaining({ method: 'POST' }),
    );
    expect(repoUpdate).toHaveBeenCalledWith(
      '1',
      expect.objectContaining({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token',
      }),
    );
  });

  it('throws when no token row exists (bootstrap not done)', async () => {
    const repo = {
      findOne: jest.fn().mockResolvedValue(null),
      update: jest.fn(),
    } as unknown as Repository<ZaloOaTokenEntity>;

    const service = new ZaloTokenService(buildConfig(), repo, {
      fetch: jest.fn(),
    });

    await expect(service.getValidAccessToken()).rejects.toThrow(
      'zalo_oa_tokens is empty',
    );
  });
});
