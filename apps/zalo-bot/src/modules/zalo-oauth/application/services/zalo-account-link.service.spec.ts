import { createHash } from 'crypto';
import { ConfigService } from '@nestjs/config';
import type { Repository } from 'typeorm';
import { ZaloAccountLinkService } from './zalo-account-link.service';
import { ZaloAccountLinkEntity } from '@zalo/infrastructure/database/entities/zalo-account-link.entity';

function buildConfig(): ConfigService {
  return {
    getOrThrow: (key: string) =>
      ({ ZALO_APP_ID: 'app-1', ZALO_APP_SECRET_KEY: 'secret-1' })[key],
  } as unknown as ConfigService;
}

describe('ZaloAccountLinkService', () => {
  it('builds a PKCE pair where code_challenge = base64url(sha256(code_verifier))', () => {
    const service = new ZaloAccountLinkService(
      buildConfig(),
      {} as unknown as Repository<ZaloAccountLinkEntity>,
    );

    const { codeVerifier, codeChallenge } = service.buildPkcePair();

    const expected = createHash('sha256')
      .update(codeVerifier)
      .digest()
      .toString('base64url');
    expect(codeChallenge).toBe(expected);
  });

  it('exchanges an authorization code for the Zalo user id/name', async () => {
    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ access_token: 'user-token-1' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () =>
          Promise.resolve({
            error: 0,
            id: 'zalo-user-1',
            name: 'Nguyen Van A',
          }),
      });

    global.fetch = fetchMock;

    const service = new ZaloAccountLinkService(
      buildConfig(),
      {} as unknown as Repository<ZaloAccountLinkEntity>,
    );

    const user = await service.exchangeCodeForZaloUser(
      'auth-code',
      'verifier-1',
    );

    expect(user).toEqual({ id: 'zalo-user-1', name: 'Nguyen Van A' });
    const calls = fetchMock.mock.calls as unknown as Array<
      [string, RequestInit]
    >;
    expect(calls[0]?.[0]).toBe('https://oauth.zaloapp.com/v4/access_token');
    expect(calls[0]?.[1].method).toBe('POST');
    expect(calls[1]?.[0]).toContain('https://graph.zalo.me/v2.0/me');
    const meHeaders = calls[1]?.[1].headers as Record<string, string>;
    expect(meHeaders['access_token']).toBe('user-token-1');

    delete global.fetch;
  });

  it('upserts a link and looks it up by zaloUserId', async () => {
    const executeFn = jest.fn().mockResolvedValue(undefined);
    const queryBuilder = {
      delete: jest.fn().mockReturnThis(),
      from: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      insert: jest.fn().mockReturnThis(),
      into: jest.fn().mockReturnThis(),
      values: jest.fn().mockReturnThis(),
      orUpdate: jest.fn().mockReturnThis(),
      execute: executeFn,
    };
    const em = {
      createQueryBuilder: jest.fn().mockReturnValue(queryBuilder),
      execute: executeFn,
    };
    const repo = {
      manager: {
        transaction: (fn: (em: typeof em) => unknown) => fn(em),
      },
      findOne: jest.fn().mockResolvedValue({ userId: 42 }),
    } as unknown as Repository<ZaloAccountLinkEntity>;

    const service = new ZaloAccountLinkService(buildConfig(), repo);

    await service.upsertLink(42, 'zalo-user-1');
    expect(executeFn).toHaveBeenCalledTimes(2);

    const userId = await service.findUserIdByZaloId('zalo-user-1');
    expect(userId).toBe(42);
  });
});
