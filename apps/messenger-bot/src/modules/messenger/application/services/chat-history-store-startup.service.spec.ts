import { ChatHistoryStoreStartupService } from './chat-history-store-startup.service';
import { ChatHistoryStoreResolver } from '../../infrastructure/persistence/chat-history.store.resolver';
import { MessengerChatSharedConfigService } from './messenger-chat-shared-config.service';
import type { RedisClientPort } from '@wispace/bot-common/redis';

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
      getNativeClient: () =>
        overrides.redisEnabled
          ? overrides.active === 'redis'
            ? {}
            : null
          : null,
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

  it('fails closed when redis history is configured but Redis is disabled', async () => {
    await expect(
      build({ configured: 'redis', redisEnabled: false }).onModuleInit(),
    ).rejects.toThrow(/refusing to silently fall back to memory/);
  }, 15_000);

  it('fails closed when redis history is configured but the client is unavailable', async () => {
    await expect(
      build({
        configured: 'redis',
        redisEnabled: true,
        active: 'memory',
      }).onModuleInit(),
    ).rejects.toThrow(/refusing to silently fall back to memory/);
  }, 15_000);

  it('logs the active store when configuration is honoured', async () => {
    await expect(
      build({
        configured: 'redis',
        redisEnabled: true,
        active: 'redis',
      }).onModuleInit(),
    ).resolves.toBeUndefined();
    await expect(
      build({ configured: 'memory' }).onModuleInit(),
    ).resolves.toBeUndefined();
  });
});
