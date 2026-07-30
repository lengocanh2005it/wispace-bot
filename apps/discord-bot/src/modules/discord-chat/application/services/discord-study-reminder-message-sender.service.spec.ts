import { DiscordStudyReminderMessageSenderService } from './discord-study-reminder-message-sender.service';
import { DiscordOutboundService } from './discord-outbound.service';

describe('DiscordStudyReminderMessageSenderService', () => {
  it('sends text via outbound service', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const outbound = { sendText } as unknown as DiscordOutboundService;
    const service = new DiscordStudyReminderMessageSenderService(outbound);

    await service.sendText({ externalUserId: 'u1', text: 'hello' });

    expect(sendText).toHaveBeenCalledWith('u1', 'hello');
  });

  it('logs warning and re-throws on failure', async () => {
    const sendText = jest.fn().mockRejectedValue(new Error('send failed'));
    const outbound = { sendText } as unknown as DiscordOutboundService;
    const service = new DiscordStudyReminderMessageSenderService(outbound);

    await expect(
      service.sendText({ externalUserId: 'u1', text: 'hello' }),
    ).rejects.toThrow('send failed');
  });
});
