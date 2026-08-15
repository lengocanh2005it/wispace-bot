import type { DiscordOutboundService } from '@discord/modules/discord-chat/application/services/discord-outbound.service';
import { DiscordRelinkNotifier } from './discord-relink-notifier.service';

describe('DiscordRelinkNotifier (#137 item 5)', () => {
  it('sends the relink notice DM to the Discord account', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const notifier = new DiscordRelinkNotifier({
      sendText,
    } as unknown as DiscordOutboundService);

    await notifier.notify('discord-user-1', 99);

    expect(sendText).toHaveBeenCalledWith(
      'discord-user-1',
      expect.stringContaining('WISPACE khác'),
    );
  });

  it('swallows DM failures (best-effort notice)', async () => {
    const sendText = jest.fn().mockRejectedValue(new Error('cannot DM user'));
    const notifier = new DiscordRelinkNotifier({
      sendText,
    } as unknown as DiscordOutboundService);

    await expect(
      notifier.notify('discord-user-1', undefined),
    ).resolves.toBeUndefined();
  });
});
