import type { RedisClientPort } from '@messenger/infrastructure/redis/redis.client.port';
import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';
import { RedisWebhookDedupeStore } from './redis-webhook-dedupe.store';

describe('RedisWebhookDedupeStore', () => {
  const createStore = (client: { set: jest.Mock } | null) => {
    const redisClient = {
      isEnabled: () => client !== null,
      getNativeClient: () => client,
      ping: jest.fn(),
    } as unknown as RedisClientPort;

    const sharedConfig = {
      getWebhookDedupeRetentionMs: () => 86_400_000,
    } as MessengerChatSharedConfigService;

    return new RedisWebhookDedupeStore(redisClient, sharedConfig);
  };

  it('returns false when redis client is unavailable', async () => {
    const store = createStore(null);
    await expect(store.isDuplicateMessageMid('mid-1', 'psid-1')).resolves.toBe(
      false,
    );
  });

  it('marks first mid as new and second as duplicate', async () => {
    const client = {
      set: jest.fn().mockResolvedValueOnce('OK').mockResolvedValueOnce(null),
    };

    const store = createStore(client);

    await expect(store.isDuplicateMessageMid('mid-1', 'psid-1')).resolves.toBe(
      false,
    );
    await expect(store.isDuplicateMessageMid('mid-1', 'psid-1')).resolves.toBe(
      true,
    );

    expect(client.set).toHaveBeenNthCalledWith(
      1,
      'dedupe:mid:mid-1',
      '1',
      'EX',
      86400,
      'NX',
    );
  });

  it('dedupes postback with short ttl', async () => {
    const client = {
      set: jest.fn().mockResolvedValueOnce('OK'),
    };

    const store = createStore(client);
    await store.isDuplicatePostback('psid-1', 'MENU_REPORT');

    expect(client.set).toHaveBeenCalledWith(
      'dedupe:postback:psid-1:MENU_REPORT',
      '1',
      'EX',
      15,
      'NX',
    );
  });
});
