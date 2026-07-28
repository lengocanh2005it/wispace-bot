import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';
import { MemoryWebhookDedupeStore } from './memory-webhook-dedupe.store';
import { RedisWebhookDedupeStore } from './redis-webhook-dedupe.store';
import { WebhookDedupeStoreResolver } from './webhook-dedupe.store.resolver';

describe('WebhookDedupeStoreResolver', () => {
  const createResolver = (
    configured: 'memory' | 'redis',
    redisAvailable = true,
  ) => {
    const sharedConfig = {
      getDedupeStore: () => configured,
    } as MessengerChatSharedConfigService;

    const memoryStore = {
      isDuplicateMessageMid: jest.fn(),
    } as unknown as MemoryWebhookDedupeStore;
    const redisStore = {
      isAvailable: () => redisAvailable,
      isDuplicateMessageMid: jest.fn(),
    } as unknown as RedisWebhookDedupeStore;

    return new WebhookDedupeStoreResolver(
      sharedConfig,
      memoryStore,
      redisStore,
    );
  };

  it('resolves redis when configured and available', () => {
    expect(createResolver('redis', true).resolveStoreKind()).toBe('redis');
  });

  it('falls back to memory when redis configured but unavailable', () => {
    expect(createResolver('redis', false).resolveStoreKind()).toBe('memory');
  });
});
