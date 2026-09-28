import {
  MemoryClarificationStateStore,
  RedisClarificationStateStore,
  createClarificationStateStore,
} from './clarification-state';

describe('clarification state stores', () => {
  it('accepts Redis state written under higher limits and a longer TTL', async () => {
    const createdAt = Date.now();
    const raw = JSON.stringify({
      phase: 'awaiting_choice',
      attempts: 2,
      menuResets: 1,
      version: 1,
      createdAt,
      expiresAt: createdAt + 30_000,
      lastChoice: 'schedule',
    });
    const client = {
      get: jest.fn().mockResolvedValue(raw),
    };
    const store = new RedisClarificationStateStore(
      {
        isConfiguredEnabled: () => true,
        isEnabled: () => true,
        getNativeClient: () => client,
      },
      'chat:clarification:test',
    );

    await expect(store.get('u1')).resolves.toMatchObject({
      attempts: 2,
      menuResets: 1,
      expiresAt: createdAt + 30_000,
    });
  });

  it('creates memory store when Redis is not configured, and Redis store when configured', () => {
    const memStore = createClarificationStateStore({
      platform: 'test',
    });
    expect(memStore).toBeInstanceOf(MemoryClarificationStateStore);

    const memStoreDisabledRedis = createClarificationStateStore({
      platform: 'test',
      redisClient: {
        isConfiguredEnabled: () => false,
        isEnabled: () => false,
        getNativeClient: () => null,
      } as never,
    });
    expect(memStoreDisabledRedis).toBeInstanceOf(MemoryClarificationStateStore);

    const redisStore = createClarificationStateStore({
      platform: 'test',
      redisClient: {
        isConfiguredEnabled: () => true,
        isEnabled: () => true,
        getNativeClient: () => ({}),
      } as never,
    });
    expect(redisStore).toBeInstanceOf(RedisClarificationStateStore);
  });
});
