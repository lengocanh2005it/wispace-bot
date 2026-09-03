import { RedisBurstCounter } from './redis-burst-counter';
import { CHAT_BURST_WINDOW_MS } from './memory-burst-counter';

describe('RedisBurstCounter', () => {
  const buildRedis = (get: jest.Mock, evalMock = jest.fn()) =>
    ({
      isEnabled: () => true,
      getNativeClient: () => ({ get, eval: evalMock }) as never,
    }) as never;

  it('uses platform-prefixed keys for new reservations', async () => {
    const evalMock = jest.fn().mockResolvedValue([1, 1]);
    const counter = new RedisBurstCounter(buildRedis(jest.fn(), evalMock), {
      platform: 'discord',
      legacyRead: false,
    });

    await counter.tryReserveBurst('discord-1', 2);

    const bucket = Math.floor(Date.now() / CHAT_BURST_WINDOW_MS);
    expect(evalMock).toHaveBeenCalledWith(
      expect.any(String),
      2,
      `burst:discord:discord-1:${bucket}`,
      `burst:discord:discord-1:${bucket}`,
      '120',
      '2',
    );
  });

  it('reads a legacy Messenger key while the namespace migrates', async () => {
    const get = jest
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('4');
    const counter = new RedisBurstCounter(buildRedis(get));

    await expect(counter.getBurstCount('messenger-1')).resolves.toBe(4);
    const bucket = Math.floor(Date.now() / CHAT_BURST_WINDOW_MS);
    expect(get).toHaveBeenNthCalledWith(2, `burst:messenger-1:${bucket}`);
  });
});
