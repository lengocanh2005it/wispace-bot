import { randomBytes } from 'crypto';
import { encryptAesGcm } from '@wispace/bot-common/utils';
import { TypeormZaloOauthStateStoreAdapter } from './typeorm-zalo-oauth-state-store.adapter';

const TEST_KEY = randomBytes(32);
const TEST_KEY_B64 = TEST_KEY.toString('base64');

function buildRepo(overrides: Record<string, unknown> = {}) {
  return {
    save: jest.fn().mockResolvedValue(undefined),
    query: jest.fn().mockResolvedValue([]),
    ...overrides,
  } as never;
}

describe('TypeormZaloOauthStateStoreAdapter', () => {
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

  it('encrypts code verifier and link token before persistence', async () => {
    const save = jest.fn().mockResolvedValue(undefined);
    const adapter = new TypeormZaloOauthStateStoreAdapter(buildRepo({ save }));

    await adapter.save({
      state: 'state-1',
      codeVerifier: 'verifier-123',
      linkToken: 'link-token-123',
      createdAt: new Date(),
    });

    expect(save).toHaveBeenCalledWith(
      expect.objectContaining({
        state: 'state-1',
        codeVerifier: expect.stringMatching(/^v1\./),
        linkToken: expect.stringMatching(/^v1\./),
      }),
    );
    const saved = save.mock.calls[0][0] as {
      codeVerifier: string;
      linkToken: string;
    };
    expect(saved.codeVerifier).not.toContain('verifier-123');
    expect(saved.linkToken).not.toContain('link-token-123');
  });

  it('cleans only strictly older rows with a bounded delete', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const adapter = new TypeormZaloOauthStateStoreAdapter(buildRepo({ query }));

    await adapter.cleanupExpired(new Date('2026-09-10T14:00:00.000Z'), 100);

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM "zalo_oauth_states"'),
      [new Date('2026-09-10T14:00:00.000Z'), 100],
    );
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('"created_at" < $1');
    expect(sql).toContain('LIMIT $2');
  });

  it('atomically consumes and decrypts a fresh row', async () => {
    const query = jest.fn().mockResolvedValue([
      [
        {
          state: 'state-1',
          code_verifier: encryptAesGcm('verifier-123', TEST_KEY),
          link_token: encryptAesGcm('link-token-123', TEST_KEY),
          created_at: new Date(),
        },
      ],
      1,
    ]);
    const adapter = new TypeormZaloOauthStateStoreAdapter(buildRepo({ query }));

    await expect(adapter.consume('state-1')).resolves.toEqual({
      state: 'state-1',
      codeVerifier: 'verifier-123',
      linkToken: 'link-token-123',
      createdAt: expect.any(Date),
    });
    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('DELETE FROM "zalo_oauth_states"');
    expect(sql).toContain('RETURNING');
    expect(sql).not.toMatch(/^\s*SELECT/i);
  });

  it('fails closed for missing, plaintext, and wrongly encrypted rows', async () => {
    const wrongKey = randomBytes(32);
    const query = jest
      .fn()
      .mockResolvedValueOnce([[], 0])
      .mockResolvedValueOnce([
        [
          {
            state: 'state-2',
            code_verifier: 'legacy-verifier',
            link_token: 'legacy-token',
            created_at: new Date(),
          },
        ],
        1,
      ])
      .mockResolvedValueOnce([
        [
          {
            state: 'state-3',
            code_verifier: encryptAesGcm('verifier', wrongKey),
            link_token: encryptAesGcm('token', wrongKey),
            created_at: new Date(),
          },
        ],
        1,
      ]);
    const adapter = new TypeormZaloOauthStateStoreAdapter(buildRepo({ query }));

    await expect(adapter.consume('missing')).resolves.toBeUndefined();
    await expect(adapter.consume('state-2')).resolves.toBeUndefined();
    await expect(adapter.consume('state-3')).resolves.toBeUndefined();
  });
});
