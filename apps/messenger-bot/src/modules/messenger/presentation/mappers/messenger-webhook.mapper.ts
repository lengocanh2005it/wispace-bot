import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import type {
  MessengerWebhookEvent,
  MessengerWebhookPayload,
  MessengerReferral,
  MessengerOptin,
} from '../../domain/entities/messenger.types';
import {
  MessengerEventDto,
  type MessengerWebhookPayloadDto,
} from '../dto/messenger-webhook-payload.dto';

type MessengerMessageDto = NonNullable<MessengerEventDto['message']>;
type MessengerPostbackDto = NonNullable<MessengerEventDto['postback']>;
type MessengerAttachmentDto = NonNullable<
  MessengerMessageDto['attachments']
>[number];

/**
 * Boundary mapper: copies only accepted fields from the runtime-validated
 * presentation DTO into the canonical application input (domain type).
 * The only place provider wire shapes may cross into the application layer.
 */
export function mapMessengerEvent(
  dto: MessengerEventDto,
): MessengerWebhookEvent {
  const mapped: MessengerWebhookEvent = {};
  if (dto.sender?.id !== undefined) {
    mapped.sender = { id: dto.sender.id };
  }
  if (dto.timestamp !== undefined) {
    mapped.timestamp = dto.timestamp;
  }
  if (dto.message) {
    mapped.message = mapMessage(dto.message);
  }
  if (dto.postback) {
    mapped.postback = mapPostback(dto.postback);
  }
  if (dto.referral) {
    mapped.referral = mapReferral(dto.referral);
  }
  if (dto.optin) {
    mapped.optin = mapOptin(dto.optin);
  }
  return mapped;
}

export function mapMessengerPayload(
  dto: MessengerWebhookPayloadDto,
): MessengerWebhookPayload {
  return {
    object: dto.object,
    entry: dto.entry.map((entry) => ({
      messaging: entry.messaging.map(mapMessengerEvent),
    })),
  };
}

/**
 * Re-validate a persisted raw payload (retry cron) with the same DTO used at
 * the live boundary, then map. Unknown fields are stripped (rows written by
 * older deploys stay replayable); wrong types fail safely into the normal
 * retry/backoff path.
 */
export async function validateAndMapMessengerEvent(
  raw: unknown,
): Promise<MessengerWebhookEvent> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid stored Messenger webhook event: not an object');
  }
  const dto = plainToInstance(MessengerEventDto, raw);
  const errors = await validate(dto, { whitelist: true });
  if (errors.length > 0) {
    throw new Error(
      `Invalid stored Messenger webhook event: ${formatValidationErrors(errors)}`,
    );
  }
  return mapMessengerEvent(dto);
}

function mapMessage(
  dto: MessengerMessageDto,
): NonNullable<MessengerWebhookEvent['message']> {
  const mapped: NonNullable<MessengerWebhookEvent['message']> = {};
  if (dto.mid !== undefined) {
    mapped.mid = dto.mid;
  }
  if (dto.text !== undefined) {
    mapped.text = dto.text;
  }
  if (dto.is_echo !== undefined) {
    mapped.is_echo = dto.is_echo;
  }
  if (dto.sticker_id !== undefined) {
    mapped.sticker_id = dto.sticker_id;
  }
  if (dto.attachments) {
    mapped.attachments = dto.attachments.map(mapAttachment);
  }
  if (dto.referral) {
    mapped.referral = mapReferral(dto.referral);
  }
  return mapped;
}

function mapAttachment(
  dto: MessengerAttachmentDto,
): NonNullable<
  NonNullable<MessengerWebhookEvent['message']>['attachments']
>[number] {
  const mapped: {
    type?: string;
    payload?: { url?: string; sticker_id?: number };
  } = {};
  if (dto.type !== undefined) {
    mapped.type = dto.type;
  }
  if (dto.payload) {
    const payload: { url?: string; sticker_id?: number } = {};
    if (dto.payload.url !== undefined) {
      payload.url = dto.payload.url;
    }
    if (dto.payload.sticker_id !== undefined) {
      payload.sticker_id = dto.payload.sticker_id;
    }
    mapped.payload = payload;
  }
  return mapped;
}

function mapPostback(
  dto: MessengerPostbackDto,
): NonNullable<MessengerWebhookEvent['postback']> {
  const mapped: NonNullable<MessengerWebhookEvent['postback']> = {};
  if (dto.payload !== undefined) {
    mapped.payload = dto.payload;
  }
  if (dto.referral) {
    mapped.referral = mapReferral(dto.referral);
  }
  return mapped;
}

function mapOptin(dto: MessengerEventDto['optin']): MessengerOptin {
  const mapped: MessengerOptin = {};
  if (dto?.type !== undefined) {
    mapped.type = dto.type;
  }
  if (dto?.payload !== undefined) {
    mapped.payload = dto.payload;
  }
  if (dto?.notification_messages_token !== undefined) {
    mapped.notification_messages_token = dto.notification_messages_token;
  }
  if (dto?.notification_messages_status !== undefined) {
    mapped.notification_messages_status = dto.notification_messages_status;
  }
  if (dto?.topic !== undefined) {
    mapped.topic = dto.topic;
  }
  if (dto?.frequency !== undefined) {
    mapped.frequency = dto.frequency;
  }
  if (dto?.ref !== undefined) {
    mapped.ref = dto.ref;
  }
  if (dto?.title !== undefined) {
    mapped.title = dto.title;
  }
  return mapped;
}

function mapReferral(
  dto:
    | MessengerEventDto['referral']
    | NonNullable<MessengerPostbackDto['referral']>,
): MessengerReferral {
  const mapped: MessengerReferral = {};
  if (dto?.ref !== undefined) {
    mapped.ref = dto.ref;
  }
  if (dto?.source !== undefined) {
    mapped.source = dto.source;
  }
  if (dto?.type !== undefined) {
    mapped.type = dto.type;
  }
  return mapped;
}

function formatValidationErrors(errors: ValidationError[]): string {
  return (
    errors
      .map((error) =>
        [error.property, ...Object.values(error.constraints ?? {})].join(': '),
      )
      .join('; ') || 'validation failed'
  );
}
