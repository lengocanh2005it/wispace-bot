import { ChatHistoryStoreStartupService } from './chat-history-store-startup.service';
import { ChatHistoryStoreResolver } from '../../infrastructure/persistence/chat-history.store.resolver';
import { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';
import type { RedisClientPort } from '@wispace/bot-common';

describe('ChatHistoryStoreStartupService', () => {
  const build = (
    overrides: {
      configured?: 'memory' | 'redis';
      redisEnabled?: boolean;
      active?: 'memory' | 'redis';
    } = {},
  ) => {
    const sharedConfig = {
      getHistoryStore: () => overrides.configured ?? 'memory',
      getHistoryTtlMs: () => 1_800_000,
      getHistoryMaxMessages: () => 12,
    } as MessengerChatSharedConfigService;
    const redisClient = {
      isEnabled: () => overrides.redisEnabled ?? false,
    } as unknown as RedisClientPort;
    const resolver = {
      resolveStoreKind: () => overrides.active ?? 'memory',
    } as unknown as ChatHistoryStoreResolver;
    return new ChatHistoryStoreStartupService(
      sharedConfig,
      redisClient,
      resolver,
    );
  };

  it('fails closed when redis history is configured but Redis is disabled', () => {
    expect(() =>
      build({ configured: 'redis', redisEnabled: false }).onModuleInit(),
    ).toThrow(/refusing to silently fall back to memory/);
  });

  it('fails closed when redis history is configured but the client is unavailable', () => {
    expect(() =>
      build({
        configured: 'redis',
        redisEnabled: true,
        active: 'memory',
      }).onModuleInit(),
    ).toThrow(/refusing to silently fall back to memory/);
  });

  it('logs the active store when configuration is honoured', () => {
    expect(() =>
      build({
        configured: 'redis',
        redisEnabled: true,
        active: 'redis',
      }).onModuleInit(),
    ).not.toThrow();
    expect(() => build({ configured: 'memory' }).onModuleInit()).not.toThrow();
  });
});
