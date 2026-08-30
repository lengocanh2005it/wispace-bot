import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { DiscordOauthStateService } from './discord-oauth-state.service';
import { encryptAesGcm } from '@wispace/bot-common/utils';

const TEST_KEY = randomBytes(32);
const TEST_KEY_B64 = TEST_KEY.toString('base64');

function mockRepo() {
  return {
    save: jest.fn(),
    create: jest.fn((entity) => entity),
    query: jest.fn().mockResolvedValue([]),
  };
}

describe('DiscordOauthStateService', () => {
  const originalKey = process.env.DISCORD_OAUTH_STATE_ENCRYPTION_KEY;

  beforeEach(() => {
    process.env.DISCORD_OAUTH_STATE_ENCRYPTION_KEY = TEST_KEY_B64;
  });

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env.DISCORD_OAUTH_STATE_ENCRYPTION_KEY;
    } else {
      process.env.DISCORD_OAUTH_STATE_ENCRYPTION_KEY = originalKey;
    }
  });

  describe('create', () => {
    it('generates a random state and saves it with encrypted link token at rest', async () => {
      const repo = mockRepo();
      const service = new DiscordOauthStateService(repo as never);

      const state = await service.create('link-token-123');

      expect(typeof state).toBe('string');
      expect(state.length).toBe(48); // 24 bytes hex
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.any(String),
          linkToken: expect.stringMatching(/^v1\./),
        }),
      );
      // Ensure plaintext is not stored
      const savedArg = repo.save.mock.calls[0][0];
      expect(savedArg.linkToken).not.toContain('link-token-123');
    });

    it('deletes expired states (older than TTL, bounded) when creating a new state', async () => {
      const repo = mockRepo();
      const service = new DiscordOauthStateService(repo as never);

      await service.create('link-token-123');

      expect(repo.query).toHaveBeenCalledWith(
        expect.stringContaining('DELETE FROM "discord_oauth_states"'),
        // 10 minutes in ms — the agreed TTL; pins cleanup to consume()'s expiry.
        [600_000],
      );
      const cleanupSql = repo.query.mock.calls[0][0] as string;
      expect(cleanupSql).toContain("interval '1 millisecond'");
      expect(cleanupSql).toContain('LIMIT 100');
    });

    it('still creates the state when the cleanup query fails', async () => {
      const repo = mockRepo();
      repo.query.mockRejectedValueOnce(new Error('db down'));
      const service = new DiscordOauthStateService(repo as never);

      const state = await service.create('link-token-123');

      expect(typeof state).toBe('string');
      expect(repo.save).toHaveBeenCalled();
    });
  });

  describe('consume', () => {
    it('returns decrypted linkToken when state exists and is fresh', async () => {
      const repo = mockRepo();
      const now = new Date();
      const encryptedToken = encryptAesGcm('link-token-123', TEST_KEY);

      repo.query.mockResolvedValue([
        { link_token: encryptedToken, created_at: now },
      ]);
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('some-state');
      expect(result).toEqual({ linkToken: 'link-token-123' });
    });

    it('returns undefined when state does not exist', async () => {
      const repo = mockRepo();
      repo.query.mockResolvedValue([]);
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('unknown-state');
      expect(result).toBeUndefined();
    });

    it('returns undefined when state is expired (>10min)', async () => {
      const repo = mockRepo();
      const old = new Date(Date.now() - 11 * 60 * 1000);
      const encryptedToken = encryptAesGcm('link-token-123', TEST_KEY);
      repo.query.mockResolvedValue([
        { link_token: encryptedToken, created_at: old },
      ]);
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('some-state');
      expect(result).toBeUndefined();
    });

    it('fails closed when state value is legacy plaintext without v1 prefix', async () => {
      const repo = mockRepo();
      const now = new Date();
      repo.query.mockResolvedValue([
        { link_token: 'legacy-plaintext-token', created_at: now },
      ]);
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('some-state');
      expect(result).toBeUndefined();
    });

    it('fails closed when decryption key is incorrect', async () => {
      const repo = mockRepo();
      const now = new Date();
      const wrongKey = randomBytes(32);
      const encryptedWithWrongKey = encryptAesGcm('link-token-123', wrongKey);

      repo.query.mockResolvedValue([
        { link_token: encryptedWithWrongKey, created_at: now },
      ]);
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('some-state');
      expect(result).toBeUndefined();
    });

    it('does not log the raw state nonce when decryption fails', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const repo = mockRepo();
      repo.query.mockResolvedValue([
        { link_token: 'legacy-plaintext-token', created_at: new Date() },
      ]);
      const service = new DiscordOauthStateService(repo as never);

      await service.consume('raw-state-nonce-123');

      const warnCalls = warnSpy.mock.calls.map((call) => String(call[0]));
      for (const line of warnCalls) {
        expect(line).not.toContain('raw-state-nonce-123');
      }
      warnSpy.mockRestore();
    });

    it('consumes via a single atomic DELETE..RETURNING (no read-then-delete race)', async () => {
      const repo = mockRepo();
      const service = new DiscordOauthStateService(repo as never);

      await service.consume('some-state');

      expect(repo.query).toHaveBeenCalledTimes(1);
      const sql = repo.query.mock.calls[0][0] as string;
      expect(sql).toContain('DELETE FROM "discord_oauth_states"');
      expect(sql).toContain('RETURNING');
      expect(sql).not.toMatch(/^\s*SELECT/i);
    });
  });
});
