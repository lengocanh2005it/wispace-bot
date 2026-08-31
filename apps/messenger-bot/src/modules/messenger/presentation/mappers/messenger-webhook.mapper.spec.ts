import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import {
  mapMessengerEvent,
  mapMessengerPayload,
  validateAndMapMessengerEvent,
} from './messenger-webhook.mapper';
import {
  MessengerEventDto,
  MessengerWebhookPayloadDto,
} from '../dto/messenger-webhook-payload.dto';

describe('mapMessengerEvent', () => {
  it('copies only accepted fields of a full message event', () => {
    const dto = plainToInstance(MessengerEventDto, {
      sender: { id: 'psid-1' },
      timestamp: 1_700_000_000_000,
      message: {
        mid: 'mid-1',
        text: 'hello',
        is_echo: false,
        sticker_id: 369_239_263_222_822,
        attachments: [
          {
            type: 'image',
            payload: { url: 'https://cdn.example.com/a.png' },
          },
        ],
        referral: { ref: 'token-1', source: 'ADS', type: 'OPEN_THREAD' },
      },
    });

    expect(mapMessengerEvent(dto)).toEqual({
      sender: { id: 'psid-1' },
      timestamp: 1_700_000_000_000,
      message: {
        mid: 'mid-1',
        text: 'hello',
        is_echo: false,
        sticker_id: 369_239_263_222_822,
        attachments: [
          { type: 'image', payload: { url: 'https://cdn.example.com/a.png' } },
        ],
        referral: { ref: 'token-1', source: 'ADS', type: 'OPEN_THREAD' },
      },
    });
  });

  it('drops provider fields that are not accepted at the boundary', () => {
    const dto = plainToInstance(MessengerEventDto, {
      sender: { id: 'psid-1', app_id: 999 },
      timestamp: 123,
      message: { mid: 'mid-1', text: 'hi', tags: ['x'] },
      unknownTopLevel: 'leak',
    });

    const mapped = mapMessengerEvent(dto);

    expect(mapped).toEqual({
      sender: { id: 'psid-1' },
      timestamp: 123,
      message: { mid: 'mid-1', text: 'hi' },
    });
    expect(mapped).not.toHaveProperty('unknownTopLevel');
  });

  it('copies postback, referral and optin shapes', () => {
    const dto = plainToInstance(MessengerEventDto, {
      sender: { id: 'psid-1' },
      timestamp: 123,
      postback: {
        payload: 'GET_STARTED',
        referral: { ref: 'token-2', source: 'SHORTLINK' },
      },
      referral: { ref: 'token-3' },
      optin: {
        type: 'notification_messages',
        payload: 'token-4',
        notification_messages_token: 'tok',
        frequency: 'WEEKLY',
        ref: 'token-5',
        title: 'T',
      },
    });

    expect(mapMessengerEvent(dto)).toEqual({
      sender: { id: 'psid-1' },
      timestamp: 123,
      postback: {
        payload: 'GET_STARTED',
        referral: { ref: 'token-2', source: 'SHORTLINK' },
      },
      referral: { ref: 'token-3' },
      optin: {
        type: 'notification_messages',
        payload: 'token-4',
        notification_messages_token: 'tok',
        frequency: 'WEEKLY',
        ref: 'token-5',
        title: 'T',
      },
    });
  });
});

describe('mapMessengerPayload', () => {
  it('maps entry.messaging and drops entry envelope fields', () => {
    const dto = plainToInstance(MessengerWebhookPayloadDto, {
      object: 'page',
      entry: [
        {
          id: 'page-1',
          time: 123,
          messaging: [{ sender: { id: 'psid-1' }, timestamp: 456 }],
        },
      ],
    });

    expect(mapMessengerPayload(dto)).toEqual({
      object: 'page',
      entry: [{ messaging: [{ sender: { id: 'psid-1' }, timestamp: 456 }] }],
    });
  });
});

describe('validateAndMapMessengerEvent (replay boundary)', () => {
  it('validates and maps a stored message event', async () => {
    const mapped = await validateAndMapMessengerEvent({
      sender: { id: 'psid-1' },
      timestamp: 123,
      message: { mid: 'mid-1', text: 'hello' },
    });

    expect(mapped).toEqual({
      sender: { id: 'psid-1' },
      timestamp: 123,
      message: { mid: 'mid-1', text: 'hello' },
    });
  });

  it('strips unknown fields from stored rows instead of rejecting them', async () => {
    const mapped = await validateAndMapMessengerEvent({
      sender: { id: 'psid-1', legacy_extra: 'x' },
      timestamp: 123,
      message: { mid: 'mid-1', text: 'hello', unknown_field: 1 },
      legacy_top: true,
    });

    expect(mapped).toEqual({
      sender: { id: 'psid-1' },
      timestamp: 123,
      message: { mid: 'mid-1', text: 'hello' },
    });
  });

  it('rejects a stored event with wrong field types', async () => {
    await expect(
      validateAndMapMessengerEvent({ sender: { id: 123 }, timestamp: 123 }),
    ).rejects.toThrow(/Invalid stored Messenger webhook event/);
  });

  it('rejects non-object payloads', async () => {
    await expect(validateAndMapMessengerEvent('junk')).rejects.toThrow(
      /not an object/,
    );
    await expect(validateAndMapMessengerEvent(null)).rejects.toThrow(
      /not an object/,
    );
    await expect(validateAndMapMessengerEvent([1, 2])).rejects.toThrow(
      /not an object/,
    );
  });
});
