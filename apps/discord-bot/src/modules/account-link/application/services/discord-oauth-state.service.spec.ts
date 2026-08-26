import { randomBytes } from 'crypto';
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
  });
});
