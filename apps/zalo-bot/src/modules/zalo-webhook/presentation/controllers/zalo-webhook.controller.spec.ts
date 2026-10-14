import { ThrottlerGuard } from '@nestjs/throttler';
import { createBotThrottlerOptions } from '@wispace/bot-common/redis';
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
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', handleWebhook)).toBe(
      true,
    );
    expect(Reflect.getMetadataKeys(handleWebhook)).toEqual(
      expect.arrayContaining([
        'THROTTLER:LIMITwebhook',
        'THROTTLER:TTLwebhook',
      ]),
    );

    const values: Record<string, string> = {
      WEBHOOK_RATE_LIMIT_PER_MINUTE: '45',
      WEBHOOK_RATE_LIMIT_TTL_MS: '30000',
    };
    const options = createBotThrottlerOptions(
      { get: (key: string) => values[key] } as never,
      {} as never,
    );
    if (options instanceof Array) throw new Error('Expected options object');
    const webhook = options.throttlers.find(({ name }) => name === 'webhook');
    expect(webhook).toMatchObject({ limit: 45, ttl: 30_000 });
    const context = {
      getHandler: () => handleWebhook,
      getClass: () => ZaloWebhookController,
    } as never;
    expect(webhook?.skipIf?.(context)).toBe(false);
    expect(
      webhook?.skipIf?.({
        getHandler: () => () => undefined,
        getClass: () => ZaloWebhookController,
      } as never),
    ).toBe(true);
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
