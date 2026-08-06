import {
  RedisChatHistoryStore,
  type RedisChatHistoryClient,
} from './redis-chat-history-store';

function createStore(client: RedisChatHistoryClient) {
  return new RedisChatHistoryStore(client, {
    ttlSec: 1800,
    maxMessages: 12,
    keyPrefix: 'chat:history:',
  });
}

describe('RedisChatHistoryStore', () => {
  it('reads and writes history with ttl', async () => {
    const client = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK' as const),
      del: jest.fn().mockResolvedValue(1),
    };
    const store = createStore(client);

    await store.appendTurn('psid-1', 'hi', 'hello');

    expect(client.set).toHaveBeenCalledWith(
      'chat:history:psid-1',
      JSON.stringify([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
      'EX',
      1800,
    );

    client.get.mockResolvedValueOnce(
      JSON.stringify([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
      ]),
    );

    await expect(store.getHistory('psid-1')).resolves.toEqual([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello' },
    ]);
  });

  it('returns empty when stored payload is not an array', async () => {
    const client = {
      get: jest.fn().mockResolvedValue('{"messages":[]}'),
      set: jest.fn(),
      del: jest.fn(),
    };
    const store = createStore(client);
    await expect(store.getHistory('psid-1')).resolves.toEqual([]);
  });

  it('appends tool_summary entry', async () => {
    const client = {
      get: jest.fn().mockResolvedValue(
        JSON.stringify([
          { role: 'user', content: 'hi' },
          { role: 'assistant', content: 'hello' },
        ]),
      ),
      set: jest.fn().mockResolvedValue('OK' as const),
      del: jest.fn(),
    };
    const store = createStore(client);
    await store.appendToolSummary(
      'psid-1',
      '[Đã tra cứu: get_upcoming_study_sessions]',
    );

    expect(client.set).toHaveBeenCalledWith(
      'chat:history:psid-1',
      JSON.stringify([
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        {
          role: 'tool_summary',
          content: '[Đã tra cứu: get_upcoming_study_sessions]',
        },
      ]),
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
