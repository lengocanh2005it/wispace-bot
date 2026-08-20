import { MessageLogEntity } from './message-log.entity';

describe('MessageLogEntity Privacy Guard (#262)', () => {
  it('does not define messageText property on MessageLogEntity', () => {
    const entity = new MessageLogEntity();
    entity.userId = 143;
    entity.platform = 'messenger';
    entity.externalUserId = 'psid-123';
    entity.messageType = 'FREE_FORM_CHAT_IN';
    entity.status = 'SENT';
    entity.errorMessage = null;

    expect('messageText' in entity).toBe(false);
    expect('message_text' in entity).toBe(false);
    expect((entity as Record<string, unknown>).messageText).toBeUndefined();
    expect((entity as Record<string, unknown>).message_text).toBeUndefined();
  });
});
