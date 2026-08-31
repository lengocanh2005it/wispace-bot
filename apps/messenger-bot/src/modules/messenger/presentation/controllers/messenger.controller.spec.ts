import { ThrottlerGuard } from '@nestjs/throttler';
import { readWebhookThrottleConfig } from '@wispace/bot-common/redis';
import { plainToInstance } from 'class-transformer';
import { MessengerWebhookSignatureGuard } from '@messenger/shared/common/guards/messenger-webhook-signature.guard';
import { MessengerWebhookPayloadDto } from '../dto/messenger-webhook-payload.dto';
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

describe('MessengerController payload mapping', () => {
  it('maps the validated DTO into the canonical payload before dispatch (#436)', async () => {
    const handleWebhook = jest.fn().mockResolvedValue({
      accepted: 1,
      duplicates: 0,
    });
    const controller = new MessengerController(
      { handleWebhook } as never,
      {} as never,
    );
    const dto = plainToInstance(MessengerWebhookPayloadDto, {
      object: 'page',
      entry: [
        {
          id: 'page-1',
          messaging: [{ sender: { id: 'psid-1' }, timestamp: 123 }],
        },
        {
          messaging: [
            {
              sender: { id: 'psid-2' },
              timestamp: 456,
              postback: { payload: 'GET_LEARNING_REPORT' },
            },
          ],
        },
      ],
    });

    await controller.receiveWebhook(dto);

    // Entry envelope fields (id/time) and provider-only fields must not
    // cross the boundary — the application consumes the canonical shape.
    expect(handleWebhook).toHaveBeenCalledWith({
      object: 'page',
      entry: [
        { messaging: [{ sender: { id: 'psid-1' }, timestamp: 123 }] },
        {
          messaging: [
            {
              sender: { id: 'psid-2' },
              timestamp: 456,
              postback: { payload: 'GET_LEARNING_REPORT' },
            },
          ],
        },
      ],
    });
  });

  it('rejects non-page webhook objects before mapping', async () => {
    const handleWebhook = jest.fn();
    const controller = new MessengerController(
      { handleWebhook } as never,
      {} as never,
    );
    const dto = plainToInstance(MessengerWebhookPayloadDto, {
      object: 'instagram',
      entry: [],
    });

    await expect(controller.receiveWebhook(dto)).rejects.toThrow(
      'Unsupported webhook object',
    );
    expect(handleWebhook).not.toHaveBeenCalled();
  });
});
