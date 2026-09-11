import { createHash } from 'crypto';
import type { Repository } from 'typeorm';
import { ZaloAccountLinkService } from './zalo-account-link.service';
import { ZaloAccountLinkEntity } from '@zalo/infrastructure/database/entities/zalo-account-link.entity';
import type { ZaloOAuthClientPort } from '../ports/zalo-oauth-client.port';

function buildOAuth(
  overrides: Partial<ZaloOAuthClientPort> = {},
): ZaloOAuthClientPort {
  return {
    exchangeCodeForUser: jest.fn().mockResolvedValue({
      id: 'zalo-user-1',
      name: 'Nguyen Van A',
    }),
    refreshOaToken: jest.fn(),
    ...overrides,
  };
}

describe('ZaloAccountLinkService', () => {
  it('builds a PKCE pair where code_challenge = base64url(sha256(code_verifier))', () => {
    const service = new ZaloAccountLinkService(
      buildOAuth(),
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
    const exchangeCodeForUser = jest.fn().mockResolvedValue({
      id: 'zalo-user-1',
      name: 'Nguyen Van A',
    });

    const service = new ZaloAccountLinkService(
      buildOAuth({ exchangeCodeForUser }),
      {} as unknown as Repository<ZaloAccountLinkEntity>,
    );

    const user = await service.exchangeCodeForZaloUser(
      'auth-code',
      'verifier-1',
    );

    expect(user).toEqual({ id: 'zalo-user-1', name: 'Nguyen Van A' });
    expect(exchangeCodeForUser).toHaveBeenCalledWith('auth-code', 'verifier-1');
  });

  it('upserts a link and looks it up by zaloUserId', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ external_user_id: 'zalo-user-1' }]);
    const em = {
      query,
    };
    const repo = {
      manager: {
        transaction: (fn: (em: typeof em) => unknown) => fn(em),
      },
      findOne: jest.fn().mockResolvedValueOnce({ userId: 42 }),
    } as unknown as Repository<ZaloAccountLinkEntity>;

    const service = new ZaloAccountLinkService(buildOAuth(), repo);

    await service.upsertLink(42, 'zalo-user-1', { kind: 'absent' });
    expect(query).toHaveBeenCalledTimes(3);

    const userId = await service.findUserIdByZaloId('zalo-user-1');
    expect(userId).toBe(42);
  });

  it('rejects an absent observation when another callback inserted the mapping', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([{ user_id: 99, mapping_generation: '2' }]);
    const repo = {
      manager: {
        transaction: jest.fn((fn: (em: unknown) => Promise<void>) =>
          fn({ query }),
        ),
      },
    } as unknown as Repository<ZaloAccountLinkEntity>;
    const service = new ZaloAccountLinkService(buildOAuth(), repo);

    await expect(
      service.upsertLink(143, 'zalo-user-1', { kind: 'absent' }),
    ).rejects.toThrow(/ownership changed/i);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('accepts an absent observation when this callback already committed', async () => {
    const query = jest
      .fn()
      .mockResolvedValueOnce([
        { user_id: 143, mapping_generation: '1', link_state: 'active' },
      ]);
    const repo = {
      manager: {
        transaction: jest.fn((fn: (em: unknown) => Promise<void>) =>
          fn({ query }),
        ),
      },
    } as unknown as Repository<ZaloAccountLinkEntity>;
    const service = new ZaloAccountLinkService(buildOAuth(), repo);

    await expect(
      service.upsertLink(143, 'zalo-user-1', { kind: 'absent' }),
    ).resolves.toEqual({ relinked: false });
    expect(query).toHaveBeenCalledTimes(1);
  });

  describe('sendConsentExplainerIfDue (#596)', () => {
    it('sends the explainer exactly once when the claim wins', async () => {
      const query = jest
        .fn()
        .mockResolvedValueOnce([{ id: '1' }])
        .mockResolvedValueOnce([]);
      const releaseQb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute: jest.fn().mockResolvedValue(undefined),
      };
      const repo = {
        query,
        createQueryBuilder: jest.fn().mockReturnValue(releaseQb),
      } as unknown as Repository<ZaloAccountLinkEntity>;
      const service = new ZaloAccountLinkService(buildOAuth(), repo);
      const send = jest.fn().mockResolvedValue(undefined);

      const first = await service.sendConsentExplainerIfDue('zalo-1', send);
      // Second reconnect: claim loses → no send.
      const second = await service.sendConsentExplainerIfDue('zalo-1', send);

      expect(first).toBe(true);
      expect(send).toHaveBeenCalledTimes(1);
      expect(second).toBe(false);
      expect(send).toHaveBeenCalledWith(expect.stringContaining('báo cáo'));
    });

    it('releases the claim when the send fails so a later path can retry', async () => {
      const query = jest.fn().mockResolvedValue([{ id: '1' }]);
      const execute = jest.fn().mockResolvedValue(undefined);
      const qb = {
        update: jest.fn().mockReturnThis(),
        set: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        execute,
      };
      const repo = {
        query,
        createQueryBuilder: jest.fn().mockReturnValue(qb),
      } as unknown as Repository<ZaloAccountLinkEntity>;
      const service = new ZaloAccountLinkService(buildOAuth(), repo);
      const send = jest.fn().mockRejectedValue(new Error('Zalo down'));

      const result = await service.sendConsentExplainerIfDue('zalo-1', send);

      expect(result).toBe(false);
      expect(execute).toHaveBeenCalled();
    });
  });
});
