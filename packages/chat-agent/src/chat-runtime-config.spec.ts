import { ChatRuntimeConfig } from './chat-runtime-config';

function configFrom(
  env: Record<string, string | undefined>,
): ChatRuntimeConfig {
  return new ChatRuntimeConfig(env);
}

describe('ChatRuntimeConfig', () => {
  it.each([
    [{ CHAT_QUEUE_STORE: 'redis' }, 'redis'],
    [{ CHAT_QUEUE_STORE: ' MEMORY ', CHAT_QUEUE_SHARED: 'true' }, 'memory'],
    [{ CHAT_QUEUE_STORE: ' REDIS ' }, 'redis'],
    [{ CHAT_QUEUE_SHARED: '1' }, 'redis'],
    [{ CHAT_QUEUE_SHARED: 'YES' }, 'redis'],
    [{ CHAT_QUEUE_STORE: 'unknown', CHAT_QUEUE_SHARED: 'true' }, 'redis'],
    [{ CHAT_QUEUE_STORE: ' ', CHAT_QUEUE_SHARED: 'false' }, 'memory'],
    [{}, 'memory'],
  ])('resolves queue mode %j as %s', (env, expected) => {
    expect(configFrom(env).queueMode()).toBe(expected);
  });

  it.each([
    [undefined, 2_000],
    ['0', 0],
    ['12.9', 12],
    ['10001', 10_000],
    ['-1', 2_000],
    ['NaN', 2_000],
    ['Infinity', 2_000],
    ['nope', 2_000],
  ])('resolves debounce %s as %s', (raw, expected) => {
    expect(configFrom({ CHAT_DEBOUNCE_MS: raw }).debounceMs).toBe(expected);
  });

  it.each([
    [undefined, 20],
    ['0', 0],
    ['3.9', 3],
    ['-1', 20],
    ['NaN', 20],
    ['Infinity', 20],
    ['nope', 20],
  ])('resolves pending cap %s as %s', (raw, expected) => {
    expect(configFrom({ CHAT_MAX_PENDING_MESSAGES: raw }).maxPendingSize).toBe(
      expected,
    );
  });

  it.each([
    [undefined, 300_000],
    ['300000.9', 300_000],
    ['0', 300_000],
    ['-1', 300_000],
    ['NaN', 300_000],
    ['Infinity', 300_000],
    ['nope', 300_000],
  ])('resolves processing stuck %s as %s', (raw, expected) => {
    expect(
      configFrom({ CHAT_QUEUE_PROCESSING_STUCK_MS: raw }).processingStuckMs,
    ).toBe(expected);
  });

  it('resolves history settings per prefix with shared defaults and alias', () => {
    const config = configFrom({
      CHAT_QUEUE_SHARED: 'true',
      CHAT_HISTORY_TTL_MS: '60000.9',
      CHAT_HISTORY_MAX_MESSAGES: '8.9',
      CHAT_HISTORY_MAX_USERS: '50.9',
    });

    expect(config.history('CHAT_HISTORY_')).toEqual({
      store: 'redis',
      ttlMs: 60_000,
      maxMessages: 8,
      maxUsers: 50,
    });
  });

  it('keeps explicit history mode independent from queue mode', () => {
    const config = configFrom({
      CHAT_QUEUE_STORE: 'redis',
      CHAT_HISTORY_STORE: 'memory',
    });

    expect(config.queueMode()).toBe('redis');
    expect(config.history('CHAT_HISTORY_').store).toBe('memory');
  });

  it('keeps the legacy global history store for alternate platform prefixes', () => {
    expect(
      configFrom({ CHAT_HISTORY_STORE: 'redis' }).history('ZALO_CHAT_HISTORY_')
        .store,
    ).toBe('redis');
    expect(
      configFrom({
        CHAT_HISTORY_STORE: 'redis',
        ZALO_CHAT_HISTORY_STORE: 'memory',
      }).history('ZALO_CHAT_HISTORY_').store,
    ).toBe('memory');
  });

  it('snapshots reader values at construction', () => {
    const values: Record<string, string | undefined> = {
      CHAT_QUEUE_STORE: 'redis',
      CHAT_DEBOUNCE_MS: '100',
    };
    const config = new ChatRuntimeConfig({
      get: (key: string) => values[key],
    });

    values.CHAT_QUEUE_STORE = 'memory';
    values.CHAT_DEBOUNCE_MS = '9000';

    expect(config.queueMode()).toBe('redis');
    expect(config.debounceMs).toBe(100);
    expect(Object.isFrozen(config)).toBe(true);
  });
});
