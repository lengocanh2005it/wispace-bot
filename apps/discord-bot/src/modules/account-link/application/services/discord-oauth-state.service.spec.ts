import { randomBytes } from 'crypto';
import { Logger } from '@nestjs/common';
import { DiscordOauthStateService } from './discord-oauth-state.service';
import { encryptAesGcm } from '@wispace/bot-common/utils';

const TEST_KEY = randomBytes(32);
const TEST_KEY_B64 = TEST_KEY.toString('base64');

function mockRepo() {
  return {
    saveState: jest.fn().mockResolvedValue(undefined),
    deleteByState: jest.fn().mockResolvedValue(undefined),
    deleteExpiredBefore: jest.fn().mockResolvedValue(undefined),
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
      expect(repo.saveState).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.any(String),
          encryptedLinkToken: expect.stringMatching(/^v1\./),
        }),
      );
      // Ensure plaintext is not stored
      const savedArg = repo.saveState.mock.calls[0][0];
      expect(savedArg.encryptedLinkToken).not.toContain('link-token-123');
    });

    it('deletes expired states (older than TTL, bounded) when creating a new state', async () => {
      const repo = mockRepo();
      const service = new DiscordOauthStateService(repo as never);

      await service.create('link-token-123');

      expect(repo.deleteExpiredBefore).toHaveBeenCalledTimes(1);
      // 10 minutes in ms — the agreed TTL; pins cleanup to consume()'s expiry.
      const [cutoff, limit] = repo.deleteExpiredBefore.mock.calls[0] as [
        Date,
        number,
      ];
      const expectedCutoff = Date.now() - 600_000;
      expect(Math.abs(cutoff.getTime() - expectedCutoff)).toBeLessThan(1000);
      expect(limit).toBe(100);
    });

    it('still creates the state when the cleanup query fails', async () => {
      const repo = mockRepo();
      repo.deleteExpiredBefore.mockRejectedValueOnce(new Error('db down'));
      const service = new DiscordOauthStateService(repo as never);

      const state = await service.create('link-token-123');

      expect(typeof state).toBe('string');
      expect(repo.saveState).toHaveBeenCalled();
    });
  });

  describe('consume', () => {
    it('returns decrypted linkToken when state exists and is fresh', async () => {
      const repo = mockRepo();
      const now = new Date();
      const encryptedToken = encryptAesGcm('link-token-123', TEST_KEY);

      repo.deleteByState.mockResolvedValue({
        linkToken: encryptedToken,
        createdAt: now,
      });
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('some-state');
      expect(result).toEqual({ linkToken: 'link-token-123' });
    });

    it('returns undefined when state does not exist', async () => {
      const repo = mockRepo();
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('unknown-state');
      expect(result).toBeUndefined();
    });

    it('returns undefined when state is expired (>10min)', async () => {
      const repo = mockRepo();
      const old = new Date(Date.now() - 11 * 60 * 1000);
      const encryptedToken = encryptAesGcm('link-token-123', TEST_KEY);
      repo.deleteByState.mockResolvedValue({
        linkToken: encryptedToken,
        createdAt: old,
      });
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('some-state');
      expect(result).toBeUndefined();
    });

    it('fails closed when state value is legacy plaintext without v1 prefix', async () => {
      const repo = mockRepo();
      repo.deleteByState.mockResolvedValue({
        linkToken: 'legacy-plaintext-token',
        createdAt: new Date(),
      });
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('some-state');
      expect(result).toBeUndefined();
    });

    it('fails closed when decryption key is incorrect', async () => {
      const repo = mockRepo();
      const wrongKey = randomBytes(32);
      const encryptedWithWrongKey = encryptAesGcm('link-token-123', wrongKey);

      repo.deleteByState.mockResolvedValue({
        linkToken: encryptedWithWrongKey,
        createdAt: new Date(),
      });
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('some-state');
      expect(result).toBeUndefined();
    });

    it('does not log the raw state nonce when decryption fails', async () => {
      const warnSpy = jest
        .spyOn(Logger.prototype, 'warn')
        .mockImplementation(() => undefined);
      const repo = mockRepo();
      repo.deleteByState.mockResolvedValue({
        linkToken: 'legacy-plaintext-token',
        createdAt: new Date(),
      });
      const service = new DiscordOauthStateService(repo as never);

      await service.consume('raw-state-nonce-123');

      const warnCalls = warnSpy.mock.calls.map((call) => String(call[0]));
      for (const line of warnCalls) {
        expect(line).not.toContain('raw-state-nonce-123');
      }
      warnSpy.mockRestore();
    });

    it('consumes through the single-use repository delete exactly once', async () => {
      const repo = mockRepo();
      const service = new DiscordOauthStateService(repo as never);

      await service.consume('some-state');

      expect(repo.deleteByState).toHaveBeenCalledTimes(1);
      expect(repo.deleteByState).toHaveBeenCalledWith('some-state');
    });
  });
});
