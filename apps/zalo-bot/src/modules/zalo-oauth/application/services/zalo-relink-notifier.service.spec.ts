import { ZaloRelinkNotifier } from './zalo-relink-notifier.service';

describe('ZaloRelinkNotifier', () => {
  it('rejects a relink notice that was not sent', async () => {
    const service = new ZaloRelinkNotifier({
      sendText: jest.fn().mockResolvedValue('rate_limited'),
    } as never);

    await expect(service.notify('zalo-1', 42)).rejects.toThrow(
      'Zalo relink notice was not sent: rate_limited',
    );
  });
});
