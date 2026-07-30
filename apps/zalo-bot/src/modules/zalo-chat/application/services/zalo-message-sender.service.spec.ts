import { ZaloMessageSenderService } from './zalo-message-sender.service';
import type { ZaloOutboundService } from './zalo-outbound.service';

describe('ZaloMessageSenderService', () => {
  it('sends text via outbound service', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const outbound = { sendText } as unknown as ZaloOutboundService;
    const service = new ZaloMessageSenderService(outbound);

    await service.sendText({ externalUserId: 'u1', text: 'hello' });

    expect(sendText).toHaveBeenCalledWith('u1', 'hello');
  });

  it('logs warning and re-throws on failure', async () => {
    const sendText = jest.fn().mockRejectedValue(new Error('send failed'));
    const outbound = { sendText } as unknown as ZaloOutboundService;
    const service = new ZaloMessageSenderService(outbound);

    await expect(
      service.sendText({ externalUserId: 'u1', text: 'hello' }),
    ).rejects.toThrow('send failed');
  });
});
