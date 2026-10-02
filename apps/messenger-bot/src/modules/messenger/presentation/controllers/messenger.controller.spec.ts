import { ThrottlerGuard } from '@nestjs/throttler';
import { createBotThrottlerOptions } from '@wispace/bot-common/redis';
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
    expect(Reflect.getMetadata('THROTTLER:SKIPdefault', receiveWebhook)).toBe(
      true,
    );
    expect(Reflect.getMetadataKeys(receiveWebhook)).toEqual(
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
      getHandler: () => receiveWebhook,
      getClass: () => MessengerController,
    } as never;
    expect(webhook?.skipIf?.(context)).toBe(false);
    expect(
      webhook?.skipIf?.({
        getHandler: () => () => undefined,
        getClass: () => MessengerController,
      } as never),
    ).toBe(true);
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
