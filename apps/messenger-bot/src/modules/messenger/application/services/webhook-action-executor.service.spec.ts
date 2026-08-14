import { WebhookActionExecutorService } from './webhook-action-executor.service';
import type { MessengerWebhookEvent } from '../../domain/entities/messenger.types';
import type { WebhookAction } from '../messenger-webhook.router';

describe('WebhookActionExecutorService.send_text', () => {
  const buildService = (
    overrides: {
      sendText?: jest.Mock;
    } = {},
  ) => {
    const outbound = {
      sendTextViaPsid:
        overrides.sendText ?? jest.fn().mockResolvedValue(undefined),
      sendRichFollowUps: jest.fn().mockResolvedValue(undefined),
    };
    const service = new WebhookActionExecutorService(
      { get: jest.fn() } as never,
      outbound as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {},
    );
    return { service, outbound };
  };

  const action: WebhookAction = {
    type: 'send_text',
    psid: 'psid-1',
    text: 'Chào bạn!',
    messageType: 'WELCOME',
  };

  const event = { sender: { id: 'psid-1' } } as MessengerWebhookEvent;

  it('awaits delivery and resolves when Meta accepts the send', async () => {
    const { service, outbound } = buildService();

    await expect(
      service.executeAction(
        action,
        event,
        jest.fn().mockResolvedValue(undefined),
      ),
    ).resolves.toBeUndefined();

    expect(outbound.sendTextViaPsid).toHaveBeenCalledWith({
      psid: 'psid-1',
      text: 'Chào bạn!',
      messageType: 'WELCOME',
    });
  });

  it('propagates delivery failures so the durable inbox retries the event', async () => {
    const sendText = jest
      .fn()
      .mockRejectedValue(new Error('Meta Send API 500'));
    const { service } = buildService({ sendText });

    await expect(
      service.executeAction(
        action,
        event,
        jest.fn().mockResolvedValue(undefined),
      ),
    ).rejects.toThrow('Meta Send API 500');
  });
});
