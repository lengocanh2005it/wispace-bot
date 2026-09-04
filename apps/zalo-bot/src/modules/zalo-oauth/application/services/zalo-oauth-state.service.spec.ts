import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
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

  it('deletes expired states (older than TTL, bounded) when creating a new state', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new ZaloOauthStateService(
      buildRepo({ query, save: jest.fn().mockResolvedValue(undefined) }),
    );

    await service.create('verifier-123', 'link-token-123');

    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM "zalo_oauth_states"'),
      // 10 minutes in ms — the agreed TTL; pins cleanup to consume()'s expiry.
      [600_000],
    );
    const cleanupSql = query.mock.calls[0][0] as string;
    expect(cleanupSql).toContain("interval '1 millisecond'");
    expect(cleanupSql).toContain('LIMIT 100');
  });

  it('still creates the state when the cleanup query fails', async () => {
    const query = jest.fn().mockRejectedValueOnce(new Error('db down'));
    const save = jest.fn().mockResolvedValue(undefined);
    const service = new ZaloOauthStateService(buildRepo({ query, save }));

    const state = await service.create('verifier-123', 'link-token-123');

    expect(state.length).toBeGreaterThan(10);
    expect(save).toHaveBeenCalled();
  });

  it('atomically consumes and decrypts a fresh state', async () => {
    const encryptedVerifier = encryptAesGcm('verifier-123', TEST_KEY);
    const encryptedLinkToken = encryptAesGcm('link-token-123', TEST_KEY);

    const query = jest.fn().mockResolvedValue([
      [
        {
          code_verifier: encryptedVerifier,
          link_token: encryptedLinkToken,
          created_at: new Date(),
        },
      ],
      1,
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
      [
        {
          code_verifier: encryptedVerifier,
          link_token: encryptedLinkToken,
          created_at: new Date(Date.now() - 11 * 60 * 1000),
        },
      ],
      1,
    ]);
    const service = new ZaloOauthStateService(buildRepo({ query }));

    const codeVerifier = await service.consume('state-1');

    expect(codeVerifier).toBeUndefined();
  });

  it('returns undefined when the state does not exist (real [[], 0] tuple shape)', async () => {
    const query = jest.fn().mockResolvedValue([[], 0]);
    const service = new ZaloOauthStateService(buildRepo({ query }));

    await expect(service.consume('missing')).resolves.toBeUndefined();
  });

  it('fails closed when state values are legacy plaintext without v1 prefix', async () => {
    const query = jest.fn().mockResolvedValue([
      [
        {
          code_verifier: 'legacy-verifier',
          link_token: 'legacy-token',
          created_at: new Date(),
        },
      ],
      1,
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
      [
        {
          code_verifier: encryptedVerifier,
          link_token: encryptedLinkToken,
          created_at: new Date(),
        },
      ],
      1,
    ]);
    const service = new ZaloOauthStateService(buildRepo({ query }));

    const consumed = await service.consume('state-1');
    expect(consumed).toBeUndefined();
  });

  it('does not log the raw state nonce when decryption fails', async () => {
    const warnSpy = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    const query = jest.fn().mockResolvedValue([
      [
        {
          code_verifier: 'legacy-verifier',
          link_token: 'legacy-token',
          created_at: new Date(),
        },
      ],
      1,
    ]);
    const service = new ZaloOauthStateService(buildRepo({ query }));

    await service.consume('raw-state-nonce-123');

    const warnCalls = warnSpy.mock.calls.map((call) => String(call[0]));
    for (const line of warnCalls) {
      expect(line).not.toContain('raw-state-nonce-123');
    }
    warnSpy.mockRestore();
  });

  it('consumes via a single atomic DELETE..RETURNING (no read-then-delete race)', async () => {
    const query = jest.fn().mockResolvedValue([]);
    const service = new ZaloOauthStateService(buildRepo({ query }));

    await service.consume('state-1');

    expect(query).toHaveBeenCalledTimes(1);
    const sql = query.mock.calls[0][0] as string;
    expect(sql).toContain('DELETE FROM "zalo_oauth_states"');
    expect(sql).toContain('RETURNING');
    expect(sql).not.toMatch(/^\s*SELECT/i);
  });
});
