import { ThrottlerGuard } from '@nestjs/throttler';
import { readWebhookThrottleConfig } from '@wispace/bot-common';
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
    const limit = Reflect.getMetadata(
      'THROTTLER:LIMITdefault',
      receiveWebhook,
    ) as () => number;
    const ttl = Reflect.getMetadata(
      'THROTTLER:TTLdefault',
      receiveWebhook,
    ) as () => number;
    const config = readWebhookThrottleConfig((key) => process.env[key]);
    expect(limit()).toBe(config.limit);
    expect(ttl()).toBe(config.ttlMs);
  });
});
