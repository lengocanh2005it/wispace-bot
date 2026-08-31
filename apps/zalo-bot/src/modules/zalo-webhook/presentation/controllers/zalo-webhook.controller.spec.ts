import { ThrottlerGuard } from '@nestjs/throttler';
import { readWebhookThrottleConfig } from '@wispace/bot-common/redis';
import { plainToInstance } from 'class-transformer';
import { ZaloWebhookEventDto } from '../dto/zalo-webhook-event.dto';
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

describe('ZaloWebhookController payload mapping', () => {
  it('maps the validated DTO into the canonical event before ingestion (#436)', async () => {
    const ingestEvent = jest.fn().mockResolvedValue(true);
    const controller = new ZaloWebhookController({ ingestEvent } as never);
    const dto = plainToInstance(ZaloWebhookEventDto, {
      app_id: '123',
      event_name: 'user_send_text',
      timestamp: '1700000000000',
      sender: { id: 'zaloid-1' },
      message: { text: 'xin chao', msg_id: 'msg-1' },
    });

    await controller.handleWebhook(dto);

    // Ingestion must receive the canonical application shape, not the
    // provider DTO instance (stripping is asserted at the mapper level).
    expect(ingestEvent).toHaveBeenCalledWith({
      app_id: '123',
      event_name: 'user_send_text',
      timestamp: '1700000000000',
      sender: { id: 'zaloid-1' },
      message: { text: 'xin chao', msg_id: 'msg-1' },
    });
  });
});
