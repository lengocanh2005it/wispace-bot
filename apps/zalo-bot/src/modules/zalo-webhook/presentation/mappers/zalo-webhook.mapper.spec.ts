import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { mapZaloEvent, validateAndMapZaloEvent } from './zalo-webhook.mapper';
import { ZaloWebhookEventDto } from '../dto/zalo-webhook-event.dto';

describe('mapZaloEvent', () => {
  it('copies only accepted fields of a text message event', () => {
    const dto = plainToInstance(ZaloWebhookEventDto, {
      app_id: '123',
      event_name: 'user_send_text',
      timestamp: '1700000000000',
      sender: { id: 'zaloid-1' },
      recipient: { id: 'oa-1' },
      oa_id: 'oa-1',
      user_id_by_app: 'user-by-app',
      message: { text: 'xin chao', msg_id: 'msg-1' },
    });

    expect(mapZaloEvent(dto)).toEqual({
      app_id: '123',
      event_name: 'user_send_text',
      timestamp: '1700000000000',
      sender: { id: 'zaloid-1' },
      recipient: { id: 'oa-1' },
      oa_id: 'oa-1',
      user_id_by_app: 'user-by-app',
      message: { text: 'xin chao', msg_id: 'msg-1' },
    });
  });

  it('drops provider fields that are not accepted at the boundary', () => {
    const dto = plainToInstance(ZaloWebhookEventDto, {
      app_id: '123',
      event_name: 'user_send_text',
      sender: { id: 'zaloid-1' },
      message: { text: 'hi', msg_id: 'msg-1' },
    });
    const withUnknown = { ...dto, unknown_field: 'leak' } as object;

    const mapped = mapZaloEvent(withUnknown as never);

    expect(mapped).toEqual({
      app_id: '123',
      event_name: 'user_send_text',
      sender: { id: 'zaloid-1' },
      message: { text: 'hi', msg_id: 'msg-1' },
    });
    expect(mapped).not.toHaveProperty('unknown_field');
  });

  it('copies follow event shape', () => {
    const dto = plainToInstance(ZaloWebhookEventDto, {
      app_id: '123',
      event_name: 'follow',
      timestamp: '1700000000000',
      follower: { id: 'zaloid-2' },
    });

    expect(mapZaloEvent(dto)).toEqual({
      app_id: '123',
      event_name: 'follow',
      timestamp: '1700000000000',
      follower: { id: 'zaloid-2' },
    });
  });
});

describe('validateAndMapZaloEvent (replay boundary)', () => {
  it('validates and maps a stored follow event', async () => {
    const mapped = await validateAndMapZaloEvent({
      app_id: '123',
      event_name: 'follow',
      follower: { id: 'zaloid-2' },
    });

    expect(mapped).toEqual({
      app_id: '123',
      event_name: 'follow',
      follower: { id: 'zaloid-2' },
    });
  });

  it('strips unknown fields from stored rows instead of rejecting them', async () => {
    const mapped = await validateAndMapZaloEvent({
      app_id: '123',
      event_name: 'user_send_text',
      sender: { id: 'zaloid-1', legacy_extra: 'x' },
      message: { text: 'hello', msg_id: 'msg-1' },
      legacy_top: true,
    });

    expect(mapped).toEqual({
      app_id: '123',
      event_name: 'user_send_text',
      sender: { id: 'zaloid-1' },
      message: { text: 'hello', msg_id: 'msg-1' },
    });
  });

  it('rejects a stored event with an unknown event_name', async () => {
    await expect(
      validateAndMapZaloEvent({
        app_id: '123',
        event_name: 'brand_new_event',
        sender: { id: 'zaloid-1' },
      }),
    ).rejects.toThrow(/Invalid stored Zalo webhook event/);
  });

  it('rejects non-object payloads', async () => {
    await expect(validateAndMapZaloEvent('junk')).rejects.toThrow(
      /not an object/,
    );
    await expect(validateAndMapZaloEvent(null)).rejects.toThrow(
      /not an object/,
    );
    await expect(validateAndMapZaloEvent([1, 2])).rejects.toThrow(
      /not an object/,
    );
  });
});
