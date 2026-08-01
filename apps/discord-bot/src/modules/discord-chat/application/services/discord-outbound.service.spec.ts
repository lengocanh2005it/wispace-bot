import type { Client } from 'discord.js';
import { DiscordOutboundService } from './discord-outbound.service';

function buildClientStub(fetch: jest.Mock): Client {
  return { users: { fetch } } as unknown as Client;
}

describe('DiscordOutboundService', () => {
  it('fetches the Discord user and sends a DM', async () => {
    const send = jest.fn().mockResolvedValue(undefined);
    const fetch = jest.fn().mockResolvedValue({ send });

    const service = new DiscordOutboundService(buildClientStub(fetch));
    await service.sendText('discord-1', 'hello');

    expect(fetch).toHaveBeenCalledWith('discord-1');
    expect(send).toHaveBeenCalledWith('hello');
  });

  it('swallows errors when the DM fails to send', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('cannot DM user'));

    const service = new DiscordOutboundService(buildClientStub(fetch));

    await expect(
      service.sendText('discord-1', 'hello'),
    ).resolves.toBeUndefined();
  });

  it('sends a reschedule confirmation DM with confirm/cancel buttons', async () => {
    const send = jest
      .fn<Promise<void>, [{ content: string; components: unknown[] }]>()
      .mockResolvedValue(undefined);
    const fetch = jest.fn().mockResolvedValue({ send });

    const service = new DiscordOutboundService(buildClientStub(fetch));
    await service.sendRescheduleConfirmation('discord-1', 'Dời buổi học?');

    expect(fetch).toHaveBeenCalledWith('discord-1');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Dời buổi học?' }),
    );
    expect(send.mock.calls[0][0].components).toHaveLength(1);
  });

  it('sends a DM with menu buttons and optional content, returns the channel id', async () => {
    const send = jest
      .fn<
        Promise<{ channelId: string }>,
        [{ content?: string; components: unknown[] }]
      >()
      .mockResolvedValue({ channelId: 'dm-1' });
    const fetch = jest.fn().mockResolvedValue({ send });

    const service = new DiscordOutboundService(buildClientStub(fetch));
    const channelId = await service.sendMenuButtons('discord-1', 'Chào bạn!');

    expect(fetch).toHaveBeenCalledWith('discord-1');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ content: 'Chào bạn!' }),
    );
    expect(send.mock.calls[0][0].components).toHaveLength(1);
    expect(channelId).toBe('dm-1');
  });

  it('swallows errors when the reschedule confirmation DM fails to send', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('cannot DM user'));

    const service = new DiscordOutboundService(buildClientStub(fetch));

    await expect(
      service.sendRescheduleConfirmation('discord-1', 'Dời buổi học?'),
    ).resolves.toBeUndefined();
  });
});
