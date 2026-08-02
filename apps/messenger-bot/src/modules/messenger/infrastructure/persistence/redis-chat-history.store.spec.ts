import type { RedisClientPort } from '@wispace/bot-common';
import { MessengerChatSharedConfigService } from '../../application/services/messenger-chat-shared-config.service';
import { RedisChatHistoryStore } from './redis-chat-history.store';

describe('RedisChatHistoryStore', () => {
  const createStore = (
    client: {
      get: jest.Mock;
      set: jest.Mock;
      del: jest.Mock;
    } | null,
  ) => {
    const redisClient = {
      isEnabled: () => client !== null,
      getNativeClient: () => client,
      ping: jest.fn(),
    } as unknown as RedisClientPort;

    const sharedConfig = {
      getHistoryTtlMs: () => 1_800_000,
      getHistoryMaxMessages: () => 12,
    } as MessengerChatSharedConfigService;

    return new RedisChatHistoryStore(redisClient, sharedConfig);
  };

  it('returns empty history when redis client is unavailable', async () => {
    const store = createStore(null);
    await expect(store.getHistory('psid-1')).resolves.toEqual([]);
  });

  it('reads and writes history with ttl', async () => {
    const client = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };

    const store = createStore(client);
    await store.appendTurn('psid-1', 'hi', 'hello');

    expect(client.set).toHaveBeenCalledWith(
      'chat:history:psid-1',
      JSON.stringify({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      }),
      'EX',
      1800,
    );

    client.get.mockResolvedValueOnce(
      JSON.stringify({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ],
      }),
    );

    await expect(store.getHistory('psid-1')).resolves.toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('appends tool_summary entry to Redis', async () => {
    const existingPayload = JSON.stringify({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ],
    });
    const client = {
      get: jest.fn().mockResolvedValue(existingPayload),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn(),
    };

    const store = createStore(client);
    await store.appendToolSummary(
      'psid-1',
      '[Đã tra cứu: get_upcoming_study_sessions]',
    );

    expect(client.set).toHaveBeenCalledWith(
      'chat:history:psid-1',
      JSON.stringify({
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
          {
            role: 'tool_summary',
            content: '[Đã tra cứu: get_upcoming_study_sessions]',
          },
        ],
      }),
      'EX',
      1800,
    );
  });

  it('clears history key', async () => {
    const client = {
      get: jest.fn(),
      set: jest.fn(),
      del: jest.fn().mockResolvedValue(1),
    };

    const store = createStore(client);
    await store.clear('psid-1');

    expect(client.del).toHaveBeenCalledWith('chat:history:psid-1');
  });
});
