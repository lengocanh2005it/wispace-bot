import { randomBytes } from 'crypto';
import type { Repository } from 'typeorm';
import { ZaloOauthStateService } from './zalo-oauth-state.service';
import { ZaloOauthStateEntity } from '@zalo/infrastructure/database/entities/zalo-oauth-state.entity';
import { encryptAesGcm } from '@wispace/bot-common/utils';

const TEST_KEY = randomBytes(32);
const TEST_KEY_B64 = TEST_KEY.toString('base64');

function buildRepo(overrides: Partial<Repository<ZaloOauthStateEntity>> = {}) {
  return {
    save: jest.fn(),
    query: jest.fn(),
    ...overrides,
  } as unknown as Repository<ZaloOauthStateEntity>;
}

describe('ZaloOauthStateService', () => {
  const originalKey = process.env.ZALO_OAUTH_STATE_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.ZALO_OAUTH_STATE_ENCRYPTION_KEY = TEST_KEY_B64;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.ZALO_OAUTH_STATE_ENCRYPTION_KEY;
    } else {
      process.env.ZALO_OAUTH_STATE_ENCRYPTION_KEY = originalKey;
    }
  });

  it('creates a state row with encrypted codeVerifier and linkToken at rest', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloOauthStateService(buildRepo({ save }));

    const state = await service.create('verifier-123', 'link-token-123');

    expect(state.length).toBeGreaterThan(10);
    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        state,
        codeVerifier: expect.stringMatching(/^v1\./),
        linkToken: expect.stringMatching(/^v1\./),
      }),
    );

    const savedArg = save.mock.calls[0][0];
    expect(savedArg.codeVerifier).not.toContain('verifier-123');
    expect(savedArg.linkToken).not.toContain('link-token-123');
  });

  it('atomically consumes and decrypts a fresh state', async () => {
    const encryptedVerifier = encryptAesGcm('verifier-123', TEST_KEY);
    const encryptedLinkToken = encryptAesGcm('link-token-123', TEST_KEY);

    const query = jest.fn().mockResolvedValue([
      {
        code_verifier: encryptedVerifier,
        link_token: encryptedLinkToken,
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
    const encryptedVerifier = encryptAesGcm('verifier-123', TEST_KEY);
    const encryptedLinkToken = encryptAesGcm('link-token-123', TEST_KEY);

    const query = jest.fn().mockResolvedValue([
      {
        code_verifier: encryptedVerifier,
        link_token: encryptedLinkToken,
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

  it('fails closed when state values are legacy plaintext without v1 prefix', async () => {
    const query = jest.fn().mockResolvedValue([
      {
        code_verifier: 'legacy-verifier',
        link_token: 'legacy-token',
        created_at: new Date(),
      },
    ]);
    const service = new ZaloOauthStateService(buildRepo({ query }));

    const consumed = await service.consume('state-1');
    expect(consumed).toBeUndefined();
  });

  it('fails closed when decryption key is incorrect', async () => {
    const wrongKey = randomBytes(32);
    const encryptedVerifier = encryptAesGcm('verifier-123', wrongKey);
    const encryptedLinkToken = encryptAesGcm('link-token-123', wrongKey);

    const query = jest.fn().mockResolvedValue([
      {
        code_verifier: encryptedVerifier,
        link_token: encryptedLinkToken,
        created_at: new Date(),
      },
    ]);
    const service = new ZaloOauthStateService(buildRepo({ query }));

    const consumed = await service.consume('state-1');
    expect(consumed).toBeUndefined();
  });
});
