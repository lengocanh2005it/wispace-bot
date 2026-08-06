import { ConfigService } from '@nestjs/config';
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
  });
});
