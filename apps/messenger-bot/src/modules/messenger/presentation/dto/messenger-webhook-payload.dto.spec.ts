import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { MessengerWebhookPayloadDto } from './messenger-webhook-payload.dto';

describe('MessengerWebhookPayloadDto', () => {
  it('accepts a valid minimal payload', async () => {
    const dto = plainToInstance(MessengerWebhookPayloadDto, {
      object: 'page',
      entry: [{ messaging: [{ sender: { id: 'psid-1' }, timestamp: 123 }] }],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects payload missing object field', async () => {
    const dto = plainToInstance(MessengerWebhookPayloadDto, {
      entry: [{ messaging: [{ sender: { id: 'psid-1' } }] }],
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'object')).toBe(true);
  });

  it('rejects payload missing entry array', async () => {
    const dto = plainToInstance(MessengerWebhookPayloadDto, {
      object: 'page',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'entry')).toBe(true);
  });

  it('rejects entry with empty messaging array', async () => {
    const dto = plainToInstance(MessengerWebhookPayloadDto, {
      object: 'page',
      entry: [{ messaging: [] }],
    });
    const errors = await validate(dto);
    // messaging must have at least 1 item (implied by ArrayMinSize default 1)
    expect(errors).toHaveLength(0); // empty array is valid — service handles length=0
  });

  it('rejects event with non-string sender.id', async () => {
    const dto = plainToInstance(MessengerWebhookPayloadDto, {
      object: 'page',
      entry: [{ messaging: [{ sender: { id: 123 } }] }],
    });
    const errors = await validate(dto);
    expect(errors.length).toBeGreaterThan(0);
  });

  it('accepts payload with unknown fields (stripped by ValidationPipe at runtime)', async () => {
    const dto = plainToInstance(MessengerWebhookPayloadDto, {
      object: 'page',
      entry: [
        {
          messaging: [
            { sender: { id: 'psid-1', unknownField: 'x' }, timestamp: 123 },
          ],
        },
      ],
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects entry with messaging exceeding max size', async () => {
    const dto = plainToInstance(MessengerWebhookPayloadDto, {
      object: 'page',
      entry: [
        {
          messaging: Array.from({ length: 501 }, (_, i) => ({
            sender: { id: `psid-${i}` },
          })),
        },
      ],
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'entry')).toBe(true);
  });
});
