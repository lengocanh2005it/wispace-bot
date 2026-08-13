import { ThrottlerGuard } from '@nestjs/throttler';
import { readWebhookThrottleConfig } from '@wispace/bot-common';
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
    const limit = Reflect.getMetadata(
      'THROTTLER:LIMITdefault',
      handleWebhook,
    ) as () => number;
    const ttl = Reflect.getMetadata(
      'THROTTLER:TTLdefault',
      handleWebhook,
    ) as () => number;
    const config = readWebhookThrottleConfig((key) => process.env[key]);
    expect(limit()).toBe(config.limit);
    expect(ttl()).toBe(config.ttlMs);
  });
});
