import { ConfigService } from '@nestjs/config';
import { computeCompactionCoverage } from '@wispace/chat-history';
import { PlatformChatHistoryService } from './platform-chat-history.service';

function buildService(envPrefix: string, keyPrefix: string) {
  const configService = { get: () => undefined } as unknown as ConfigService;
  return new PlatformChatHistoryService(configService, {
    envPrefix,
    keyPrefix,
  });
}

describe('PlatformChatHistoryService', () => {
  it('returns empty history for a user with no prior turns', async () => {
    const service = buildService('CHAT_HISTORY_', 'chat-history:discord:');
    await expect(service.getHistory('user-1')).resolves.toEqual([]);
  });

  it('fails closed on init when Redis history is configured but the client is unavailable', async () => {
    const configService = {
      get: (key: string) =>
        key === 'CHAT_HISTORY_STORE' ? 'redis' : undefined,
    } as unknown as ConfigService;
    const service = new PlatformChatHistoryService(
      configService,
      { envPrefix: 'CHAT_HISTORY_', keyPrefix: 'chat-history:discord:' },
      { getNativeClient: () => null },
    );

    await expect(service.onModuleInit()).rejects.toThrow(
      /refusing to silently fall back to memory/,
    );
  }, 15_000);

  it('uses Redis when the client is available at construction', async () => {
    const nativeClient = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue(1),
    };
    const configService = {
      get: (key: string) =>
        key === 'CHAT_HISTORY_STORE' ? 'redis' : undefined,
    } as unknown as ConfigService;
    const service = new PlatformChatHistoryService(
      configService,
      { envPrefix: 'CHAT_HISTORY_', keyPrefix: 'chat-history:discord:' },
      { getNativeClient: () => nativeClient },
    );

    await service.appendTurn('user-1', 'hello', 'hi there');

    expect(nativeClient.eval).toHaveBeenCalled();
  });

  it('does NOT silently downgrade to memory when Redis dies after boot (outage is loud)', async () => {
    const nativeClient = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue(1),
    };
    const configService = {
      get: (key: string) =>
        key === 'CHAT_HISTORY_STORE' ? 'redis' : undefined,
    } as unknown as ConfigService;
    const service = new PlatformChatHistoryService(
      configService,
      { envPrefix: 'CHAT_HISTORY_', keyPrefix: 'chat-history:zalo:' },
      { getNativeClient: () => nativeClient },
    );

    // Boot OK → Redis backend in use.
    await service.appendTurn('user-1', 'hello', 'hi there');

    // Outage: Redis starts failing mid-flight — the request must FAIL LOUD,
    // never fall back to a per-process memory store with divergent history.
    nativeClient.eval.mockRejectedValue(new Error('Redis connection refused'));
    nativeClient.get.mockRejectedValue(new Error('Redis connection refused'));

    await expect(service.appendTurn('user-1', 'next', 'reply')).rejects.toThrow(
      'Redis connection refused',
    );
    // The failed turn was NOT written to memory behind the app's back.
    await expect(service.getHistory('user-1')).rejects.toThrow(
      'Redis connection refused',
    );
  });

  it('appends user + assistant messages in order', async () => {
    const service = buildService('ZALO_CHAT_HISTORY_', 'chat-history:zalo:');
    await service.appendTurn('user-1', 'hello', 'hi there');

    await expect(service.getHistory('user-1')).resolves.toEqual([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
    ]);
  });

  it('keeps history isolated per user', async () => {
    const service = buildService('CHAT_HISTORY_', 'chat-history:discord:');
    await service.appendTurn('user-1', 'a', 'b');
    await service.appendTurn('user-2', 'c', 'd');

    await expect(service.getHistory('user-1')).resolves.toHaveLength(2);
    await expect(service.getHistory('user-2')).resolves.toEqual([
      { role: 'user', content: 'c' },
      { role: 'assistant', content: 'd' },
    ]);
  });

  it('trims history to the most recent 10 turns (20 messages)', async () => {
    const service = buildService('CHAT_HISTORY_', 'chat-history:discord:');
    for (let i = 0; i < 15; i++) {
      await service.appendTurn('user-1', `q${i}`, `a${i}`);
    }

    const history = await service.getHistory('user-1');
    expect(history).toHaveLength(20);
    expect(history[0]).toEqual({ role: 'user', content: 'q5' });
    expect(history[history.length - 1]).toEqual({
      role: 'assistant',
      content: 'a14',
    });
    service.onModuleDestroy();
  });

  it('clear() removes the compaction summary too (memory, #704)', async () => {
    const service = buildService('CHAT_HISTORY_', 'chat-history:discord:');
    await service.appendTurn('user-1', 'hello', 'hi there');
    const cache = service.getCompactionCache();
    const coverage = computeCompactionCoverage([{ content: 'old' }])!;
    await cache.set('user-1', { text: 'summary', coverage });
    await expect(cache.get('user-1')).resolves.toEqual({
      text: 'summary',
      coverage,
    });

    await service.clear('user-1');

    await expect(service.getHistory('user-1')).resolves.toEqual([]);
    await expect(cache.get('user-1')).resolves.toBeNull();
    service.onModuleDestroy();
  });

  it('clear() deletes both history and compaction keys (Redis, #704)', async () => {
    const nativeClient = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
      eval: jest.fn().mockResolvedValue(1),
    };
    const configService = {
      get: (key: string) =>
        key === 'CHAT_HISTORY_STORE' ? 'redis' : undefined,
    } as unknown as ConfigService;
    const service = new PlatformChatHistoryService(
      configService,
      { envPrefix: 'CHAT_HISTORY_', keyPrefix: 'chat-history:discord:' },
      { getNativeClient: () => nativeClient },
    );

    const cache = service.getCompactionCache();
    const coverage = computeCompactionCoverage([{ content: 'old' }])!;
    await cache.set('user-1', { text: 'summary', coverage });
    await service.clear('user-1');

    const deletedKeys = nativeClient.del.mock.calls.map(
      (call: string[]) => call[0],
    );
    expect(deletedKeys).toContain('chat-history:discord:user-1');
    expect(deletedKeys).toContain('chat-history:discord:compaction:user-1');
    service.onModuleDestroy();
  });
});
