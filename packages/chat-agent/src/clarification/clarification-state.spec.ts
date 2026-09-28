import fc from 'fast-check';
import { ClarificationCore } from './clarification-core';
import {
  MemoryClarificationStateStore,
  RedisClarificationStateStore,
  createClarificationStateStore,
} from './clarification-state';

// Same budget the core property suite runs at, so the property that moved here
// keeps its strength. Jest gives each test file its own module registry.
fc.configureGlobal({ numRuns: 200 });

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

  it('rejects a stale memory write using the expected version', async () => {
    const store = new MemoryClarificationStateStore();
    const state = new ClarificationCore().begin({}, Date.now(), 'menu');

    await store.set('u1', state, 0);
    await expect(store.set('u1', { ...state, version: 2 }, 0)).resolves.toBe(
      false,
    );
  });

  it('consumes a choice with a compare-and-set tombstone', async () => {
    const store = new MemoryClarificationStateStore();
    const core = new ClarificationCore();
    const state = core.begin({ userId: 42 }, Date.now(), 'menu');

    await store.set('u1', state, 0);
    const consumed = core.consume(
      state,
      { eventId: 'choice-1' },
      Date.now(),
      'schedule',
    );
    await expect(store.set('u1', consumed, state.version)).resolves.toBe(true);
    await expect(store.clear('u1', consumed.version)).resolves.toBe(true);
    await expect(store.clear('u1', consumed.version)).resolves.toBe(false);
  });

  it('fails closed when configured Redis is disabled or native client is missing', async () => {
    const state = new ClarificationCore().begin({}, Date.now(), 'menu');

    const disabledStore = new RedisClarificationStateStore(
      {
        isConfiguredEnabled: () => true,
        isEnabled: () => false,
        getNativeClient: () => null,
      },
      'chat:clarification:test',
    );

    await expect(disabledStore.get('u1')).rejects.toThrow('unavailable');
    await expect(disabledStore.set('u1', state)).rejects.toThrow('unavailable');
    await expect(disabledStore.clear('u1')).rejects.toThrow('unavailable');

    const missingClientStore = new RedisClarificationStateStore(
      {
        isConfiguredEnabled: () => true,
        isEnabled: () => true,
        getNativeClient: () => null,
      },
      'chat:clarification:test',
    );

    await expect(missingClientStore.get('u1')).rejects.toThrow('unavailable');
    await expect(missingClientStore.set('u1', state)).rejects.toThrow(
      'unavailable',
    );
    await expect(missingClientStore.clear('u1')).rejects.toThrow('unavailable');

    const notConfiguredDirectStore = new RedisClarificationStateStore(
      {
        isConfiguredEnabled: () => false,
        isEnabled: () => false,
        getNativeClient: () => null,
      },
      'chat:clarification:test',
    );

    await expect(notConfiguredDirectStore.get('u1')).rejects.toThrow(
      'unavailable',
    );
    await expect(notConfiguredDirectStore.set('u1', state)).rejects.toThrow(
      'unavailable',
    );
    await expect(notConfiguredDirectStore.clear('u1')).rejects.toThrow(
      'unavailable',
    );
  });

  it('rejects stale memory writes for every generated initial state', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: 1_000_000 }),
        async (offset) => {
          const store = new MemoryClarificationStateStore();
          const state = new ClarificationCore().begin(
            {},
            Date.now() + offset,
            'menu',
          );

          await expect(store.set('user', state, 0)).resolves.toBe(true);
          await expect(
            store.set('user', { ...state, version: state.version + 1 }, 0),
          ).resolves.toBe(false);
          await expect(store.get('user')).resolves.toEqual(state);
        },
      ),
    );
  });
});
