import type { RedisClientPort } from './redis.client.port';
import { RedisWebhookDedupeStore } from './redis-webhook-dedupe.store';

describe('RedisWebhookDedupeStore', () => {
  it('fails closed when Redis cannot mark a webhook', async () => {
    const client = {
      set: jest.fn().mockRejectedValue(new Error('redis down')),
    };
    const redisClient = {
      isEnabled: () => true,
      getNativeClient: () => client,
    } as unknown as RedisClientPort;
    const store = new RedisWebhookDedupeStore(redisClient, {
      platform: 'zalo',
      midTtlSeconds: () => 60,
    });

    await expect(store.isDuplicateMessageMid('mid-1')).resolves.toBe(true);
  });
});
