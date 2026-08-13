import { ThrottlerGuard } from '@nestjs/throttler';
import { MessengerWebhookSignatureGuard } from '@messenger/shared/common/guards/messenger-webhook-signature.guard';
import { MessengerController } from './messenger.controller';

describe('MessengerController webhook guards', () => {
  it('authenticates before applying the provider-safe throttle', () => {
    const receiveWebhook = Object.getOwnPropertyDescriptor(
      MessengerController.prototype,
      'receiveWebhook',
    )?.value as object;

    expect(Reflect.getMetadata('__guards__', receiveWebhook)).toEqual([
      MessengerWebhookSignatureGuard,
      ThrottlerGuard,
    ]);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', receiveWebhook)).toBe(
      120,
    );
  });
});
