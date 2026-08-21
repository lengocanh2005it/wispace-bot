import { DiscordOauthStateService } from './discord-oauth-state.service';

function mockRepo() {
  return {
    save: jest.fn(),
    create: jest.fn((entity) => entity),
    query: jest.fn().mockResolvedValue([]),
  };
}

describe('DiscordOauthStateService', () => {
  describe('create', () => {
    it('generates a random state and saves it with the link token', async () => {
      const repo = mockRepo();
      const service = new DiscordOauthStateService(repo as never);

      const state = await service.create('link-token-123');

      expect(typeof state).toBe('string');
      expect(state.length).toBe(48); // 24 bytes hex
      expect(repo.save).toHaveBeenCalledWith(
        expect.objectContaining({
          state: expect.any(String),
          linkToken: 'link-token-123',
        }),
      );
    });
  });

  describe('consume', () => {
    it('returns linkToken when state exists and is fresh', async () => {
      const repo = mockRepo();
      const now = new Date();
      repo.query.mockResolvedValue([
        { link_token: 'link-token-123', created_at: now },
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
      repo.query.mockResolvedValue([
        { link_token: 'link-token-123', created_at: old },
      ]);
      const service = new DiscordOauthStateService(repo as never);

      const result = await service.consume('some-state');
      expect(result).toBeUndefined();
    });
  });
});
