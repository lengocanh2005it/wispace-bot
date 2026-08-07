import type { MessengerWebhookEvent } from '../../domain/entities/messenger.types';
import { isUnsupportedUserMessage } from '../../domain/utils/webhook-predicates';

describe('webhook-message.utils', () => {
  const baseMessage = {} as NonNullable<MessengerWebhookEvent['message']>;

  it('isUnsupportedUserMessage returns false for text messages', () => {
    expect(isUnsupportedUserMessage({ ...baseMessage, text: 'hello' })).toBe(
      false,
    );
    expect(isUnsupportedUserMessage({ ...baseMessage, text: '  hi  ' })).toBe(
      false,
    );
  });

  it('isUnsupportedUserMessage returns true for sticker (L1)', () => {
    expect(
      isUnsupportedUserMessage({ ...baseMessage, sticker_id: 12345 }),
    ).toBe(true);
  });

  it('isUnsupportedUserMessage returns true for attachments without text (L1)', () => {
    expect(
      isUnsupportedUserMessage({
        ...baseMessage,
        attachments: [{ type: 'image' }],
      }),
    ).toBe(true);
  });

  it('isUnsupportedUserMessage returns false for empty message shell', () => {
    expect(isUnsupportedUserMessage({ ...baseMessage })).toBe(false);
  });
});
