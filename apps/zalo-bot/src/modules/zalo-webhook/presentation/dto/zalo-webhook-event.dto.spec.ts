import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { ZaloWebhookEventDto } from './zalo-webhook-event.dto';

describe('ZaloWebhookEventDto', () => {
  it('accepts a valid minimal event', async () => {
    const dto = plainToInstance(ZaloWebhookEventDto, {
      app_id: '12345',
      event_name: 'user_send_text',
      sender: { id: 'user-1' },
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });

  it('rejects event missing app_id', async () => {
    const dto = plainToInstance(ZaloWebhookEventDto, {
      event_name: 'user_send_text',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'app_id')).toBe(true);
  });

  it('rejects event missing event_name', async () => {
    const dto = plainToInstance(ZaloWebhookEventDto, {
      app_id: '12345',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'event_name')).toBe(true);
  });

  it('rejects unknown event_name', async () => {
    const dto = plainToInstance(ZaloWebhookEventDto, {
      app_id: '12345',
      event_name: 'unknown_event',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'event_name')).toBe(true);
  });

  it('accepts all valid event names', async () => {
    const eventNames = [
      'user_send_text',
      'user_send_image',
      'user_send_sticker',
      'user_send_file',
      'user_send_location',
      'follow',
      'unfollow',
      'oa_send_text',
      'oa_send_image',
      'oa_send_list',
      'oa_send_file',
      'oa_send_sticker',
    ];
    for (const eventName of eventNames) {
      const dto = plainToInstance(ZaloWebhookEventDto, {
        app_id: '12345',
        event_name: eventName,
      });
      const errors = await validate(dto);
      expect(errors).toHaveLength(0);
    }
  });

  it('rejects non-string app_id', async () => {
    const dto = plainToInstance(ZaloWebhookEventDto, {
      app_id: 12345,
      event_name: 'user_send_text',
    });
    const errors = await validate(dto);
    expect(errors.some((e) => e.property === 'app_id')).toBe(true);
  });

  it('accepts event with unknown fields (stripped by ValidationPipe at runtime)', async () => {
    const dto = plainToInstance(ZaloWebhookEventDto, {
      app_id: '12345',
      event_name: 'user_send_text',
      malicious_field: '<script>alert(1)</script>',
    });
    const errors = await validate(dto);
    expect(errors).toHaveLength(0);
  });
});
