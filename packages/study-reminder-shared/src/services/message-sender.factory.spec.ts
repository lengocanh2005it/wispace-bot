import { wrapMessageSender } from './message-sender.factory';

describe('wrapMessageSender', () => {
  it('sends text via outbound service', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const sender = wrapMessageSender({ sendText });

    await sender.sendText({ externalUserId: 'u1', text: 'hello' });

    expect(sendText).toHaveBeenCalledWith('u1', 'hello');
  });

  it('logs warning and re-throws on failure', async () => {
    const sendText = jest.fn().mockRejectedValue(new Error('send failed'));
    const sender = wrapMessageSender({ sendText });

    await expect(
      sender.sendText({ externalUserId: 'u1', text: 'hello' }),
    ).rejects.toThrow('send failed');
  });
});
