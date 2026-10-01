import type { ZaloWebhookEvent } from '../domain/entities/zalo-webhook-event.types';
import { ZaloWebhookDispatchService } from './zalo-webhook-dispatch.service';
import type { ZaloInboundChatPort } from './ports/inbound-chat.port';

describe('ZaloWebhookDispatchService dedupe key (#1489)', () => {
  let dispatch: ZaloWebhookDispatchService;
  let handleIncomingMessage: jest.Mock;

  beforeEach(() => {
    handleIncomingMessage = jest.fn();
    const handler: ZaloInboundChatPort = {
      handleIncomingMessage,
      handleFollow: jest.fn(),
      handleUnsupportedMessage: jest.fn(),
    };
    dispatch = new ZaloWebhookDispatchService(handler);
  });

  const textEvent = (msgId?: string): ZaloWebhookEvent => ({
    app_id: 'app',
    event_name: 'user_send_text',
    sender: { id: 'zalo-1' },
    message:
      msgId === undefined
        ? { text: 'xin chao' }
        : { text: 'xin chao', msg_id: msgId },
  });

  it('derives the same key for a redelivered message', async () => {
    await dispatch.dispatch(textEvent('msg-abc'));
    await dispatch.dispatch(textEvent('msg-abc'));

    expect(handleIncomingMessage).toHaveBeenCalledTimes(2);
    expect(handleIncomingMessage.mock.calls[0][2]).toBe('msg-abc');
    expect(handleIncomingMessage.mock.calls[1][2]).toBe(
      handleIncomingMessage.mock.calls[0][2],
    );
  });

  it('still produces a stable key when the provider omits msg_id', async () => {
    await dispatch.dispatch(textEvent());
    await dispatch.dispatch(textEvent());

    const key = handleIncomingMessage.mock.calls[0][2] as string;
    expect(key).toBe(handleIncomingMessage.mock.calls[1][2]);
    expect(key).toContain('zalo-1');
  });

  it('gives different messages different keys', async () => {
    await dispatch.dispatch(textEvent('msg-1'));
    await dispatch.dispatch(textEvent('msg-2'));

    expect(handleIncomingMessage.mock.calls[0][2]).not.toBe(
      handleIncomingMessage.mock.calls[1][2],
    );
  });
});
