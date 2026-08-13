import { ThrottlerGuard } from '@nestjs/throttler';
import { ZaloWebhookSignatureGuard } from '../guards/zalo-webhook-signature.guard';
import { ZaloWebhookController } from './zalo-webhook.controller';

describe('ZaloWebhookController webhook guards', () => {
  it('authenticates before applying the provider-safe throttle', () => {
    const handleWebhook = Object.getOwnPropertyDescriptor(
      ZaloWebhookController.prototype,
      'handleWebhook',
    )?.value as object;

    expect(Reflect.getMetadata('__guards__', ZaloWebhookController)).toEqual([
      ZaloWebhookSignatureGuard,
      ThrottlerGuard,
    ]);
    expect(Reflect.getMetadata('THROTTLER:LIMITdefault', handleWebhook)).toBe(
      120,
    );
  });
});
