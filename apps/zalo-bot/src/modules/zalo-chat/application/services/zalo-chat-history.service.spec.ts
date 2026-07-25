import { ConfigService } from '@nestjs/config';
import { ZaloChatHistoryService } from './zalo-chat-history.service';

describe('ZaloChatHistoryService', () => {
  it('returns an empty history for a new user, then reflects appended turns', async () => {
    const config = {
      get: () => undefined,
    } as unknown as ConfigService;
    const service = new ZaloChatHistoryService(config);

    await expect(service.getHistory('zalo-1')).resolves.toEqual([]);

    await service.appendTurn('zalo-1', 'hi', 'hello there');
    const history = await service.getHistory('zalo-1');

    expect(history).toHaveLength(2);
    expect(history[0]).toMatchObject({ role: 'user', content: 'hi' });
    expect(history[1]).toMatchObject({
      role: 'assistant',
      content: 'hello there',
    });
  });
});
