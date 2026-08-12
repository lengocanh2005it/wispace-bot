import type { RedisClientPort } from '@wispace/bot-common';
import { ChatHistoryStoreResolver } from './chat-history.store.resolver';
import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';

describe('ChatHistoryStoreResolver', () => {
  const createResolver = (
    configured: 'memory' | 'redis',
    redisAvailable = true,
  ) => {
    const sharedConfig = {
      getHistoryStore: () => configured,
      getHistoryTtlMs: () => 1_800_000,
      getHistoryMaxMessages: () => 12,
    } as MessengerChatSharedConfigService;

    const redisClient = {
      isEnabled: () => redisAvailable,
      getNativeClient: () =>
        redisAvailable
          ? {
              get: jest.fn().mockResolvedValue(null),
              set: jest.fn().mockResolvedValue('OK'),
              del: jest.fn(),
            }
          : null,
    } as unknown as RedisClientPort;

    return new ChatHistoryStoreResolver(sharedConfig, redisClient);
  };

  it('resolves redis when configured and available', () => {
    expect(createResolver('redis', true).resolveStoreKind()).toBe('redis');
  });

  it('adopts redis when it becomes available after construction', async () => {
    let available = false;
    const nativeClient = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn(),
    };
    const redisClient = {
      isEnabled: () => available,
      getNativeClient: () => (available ? nativeClient : null),
    } as unknown as RedisClientPort;
    const sharedConfig = {
      getHistoryStore: () => 'redis',
      getHistoryTtlMs: () => 1_800_000,
      getHistoryMaxMessages: () => 12,
    } as MessengerChatSharedConfigService;
    const resolver = new ChatHistoryStoreResolver(sharedConfig, redisClient);

    expect(resolver.resolveStoreKind()).toBe('memory');

    available = true;
    await resolver.appendTurn('psid-1', 'hi', 'hello');

    expect(resolver.resolveStoreKind()).toBe('redis');
    expect(nativeClient.set).toHaveBeenCalled();
  });

  it('falls back to memory when redis configured but unavailable', () => {
    expect(createResolver('redis', false).resolveStoreKind()).toBe('memory');
  });

  it('resolves memory by default', () => {
    expect(createResolver('memory').resolveStoreKind()).toBe('memory');
  });

  it('round-trips history through the shared stores', async () => {
    const resolver = createResolver('memory');
    await resolver.appendTurn('psid-1', 'hi', 'hello');
    await resolver.appendToolSummary('psid-1', '[Đã tra cứu: get_user_goals]');

    await expect(resolver.getHistory('psid-1')).resolves.toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
      { role: 'tool_summary', content: '[Đã tra cứu: get_user_goals]' },
    ]);
  });
});
