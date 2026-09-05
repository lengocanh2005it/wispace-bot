import { wrapMessageSender } from './message-sender.factory';

describe('wrapMessageSender', () => {
  it('sends text via outbound service and forwards the full input', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const sender = wrapMessageSender({ sendText });

    const input = { externalUserId: 'u1', text: 'hello' };
    const result = await sender.sendText(input);

    expect(sendText).toHaveBeenCalledWith(
      'u1',
      'hello',
      expect.objectContaining({
        ...input,
        retryOn: 'none',
        skipDeadLetter: true,
        deadLetterOn: 'none',
      }),
    );
    expect(result).toBe('not_sent');
  });

  it('fails closed when a provider omits its delivery outcome', async () => {
    const sendText = jest.fn().mockResolvedValue(undefined);
    const sender = wrapMessageSender({ sendText });

    const result = await sender.sendText({
      externalUserId: 'u1',
      text: 'hello',
    });
    expect(result).toBe('not_sent');
  });

  it('forwards a rate-limit outcome without converting it to success', async () => {
    const sendText = jest.fn().mockResolvedValue('rate_limited');
    const sender = wrapMessageSender({ sendText });

    await expect(
      sender.sendText({ externalUserId: 'u1', text: 'hello' }),
    ).resolves.toBe('rate_limited');
  });

  it.each(['ambiguous', 'not_sent'] as const)(
    'forwards an explicit %s outcome unchanged',
    async (outcome) => {
      const sendText = jest.fn().mockResolvedValue(outcome);
      const sender = wrapMessageSender({ sendText });

      await expect(
        sender.sendText({ externalUserId: 'u1', text: 'hello' }),
      ).resolves.toBe(outcome);
    },
  );

  it('normalizes a provider ambiguity classifier to ambiguous', async () => {
    const sendText = jest.fn().mockRejectedValue(new Error('send failed'));
    const sender = wrapMessageSender({
      sendText,
      isAmbiguousDeliveryError: () => true,
    });

    await expect(
      sender.sendText({ externalUserId: 'u1', text: 'hello' }),
    ).resolves.toBe('ambiguous');
  });

  it('preserves an unclassified provider failure for dispatcher classification', async () => {
    const sendText = jest.fn().mockRejectedValue(new Error('send failed'));
    const sender = wrapMessageSender({ sendText });

    await expect(
      sender.sendText({ externalUserId: 'u1', text: 'hello' }),
    ).rejects.toThrow('send failed');
  });
});
