import type { RedisClientPort } from './redis.client.port';
import { RedisWebhookDedupeStore } from './redis-webhook-dedupe.store';

describe('RedisWebhookDedupeStore', () => {
  it('fails open with in-memory fallback when Redis cannot mark a webhook', async () => {
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

    // First call: Redis error → not treated as duplicate (message not dropped)
    await expect(store.isDuplicateMessageMid('mid-1')).resolves.toBe(false);
    // Second call within TTL: deduped by the in-memory fallback
    await expect(store.isDuplicateMessageMid('mid-1')).resolves.toBe(true);
  });

  it('uses the in-memory fallback when the Redis client is unavailable', async () => {
    const redisClient = {
      isEnabled: () => false,
      getNativeClient: () => null,
    } as unknown as RedisClientPort;
    const store = new RedisWebhookDedupeStore(redisClient, {
      platform: 'zalo',
      midTtlSeconds: () => 60,
    });

    await expect(store.isDuplicateMessageMid('mid-1')).resolves.toBe(false);
    await expect(store.isDuplicateMessageMid('mid-1')).resolves.toBe(true);
  });

  it('marks keys as duplicates when Redis returns a non-OK result', async () => {
    const client = {
      set: jest.fn().mockResolvedValue(null),
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

  it('evicts stale in-memory fallback entries', async () => {
    const client = {
      set: jest.fn().mockRejectedValue(new Error('redis down')),
    };
    const redisClient = {
      isEnabled: () => true,
      getNativeClient: () => client,
    } as unknown as RedisClientPort;
    const store = new RedisWebhookDedupeStore(redisClient, {
      platform: 'zalo',
      midTtlSeconds: () => 0,
    });

    await expect(store.isDuplicateMessageMid('mid-1')).resolves.toBe(false);
    // TTL 0 → already expired → treated as a fresh key again
    await expect(store.isDuplicateMessageMid('mid-1')).resolves.toBe(false);
  });
});
