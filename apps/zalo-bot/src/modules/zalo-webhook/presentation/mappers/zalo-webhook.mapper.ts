import { plainToInstance } from 'class-transformer';
import { validate, type ValidationError } from 'class-validator';
import type { ZaloWebhookEvent } from '../../domain/entities/zalo-webhook-event.types';
import { ZaloWebhookEventDto } from '../dto/zalo-webhook-event.dto';

/**
 * Boundary mapper: copies only accepted fields from the runtime-validated
 * presentation DTO into the canonical application input (domain type).
 * The only place provider wire shapes may cross into the application layer.
 */
export function mapZaloEvent(dto: ZaloWebhookEventDto): ZaloWebhookEvent {
  const mapped: ZaloWebhookEvent = {
    app_id: dto.app_id,
    event_name: dto.event_name,
  };
  if (dto.timestamp !== undefined) {
    mapped.timestamp = dto.timestamp;
  }
  if (dto.sender) {
    mapped.sender = { id: dto.sender.id };
  }
  if (dto.recipient) {
    mapped.recipient = { id: dto.recipient.id };
  }
  if (dto.follower) {
    mapped.follower = { id: dto.follower.id };
  }
  if (dto.oa_id !== undefined) {
    mapped.oa_id = dto.oa_id;
  }
  if (dto.user_id_by_app !== undefined) {
    mapped.user_id_by_app = dto.user_id_by_app;
  }
  if (dto.message) {
    mapped.message = {};
    if (dto.message.text !== undefined) {
      mapped.message.text = dto.message.text;
    }
    if (dto.message.msg_id !== undefined) {
      mapped.message.msg_id = dto.message.msg_id;
    }
  }
  return mapped;
}

/**
 * Re-validate a persisted raw payload (retry cron) with the same DTO used at
 * the live boundary, then map. Unknown fields are stripped (rows written by
 * older deploys stay replayable); wrong types fail safely into the normal
 * retry/backoff path.
 */
export async function validateAndMapZaloEvent(
  raw: unknown,
): Promise<ZaloWebhookEvent> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Invalid stored Zalo webhook event: not an object');
  }
  const dto = plainToInstance(ZaloWebhookEventDto, raw);
  const errors = await validate(dto, { whitelist: true });
  if (errors.length > 0) {
    throw new Error(
      `Invalid stored Zalo webhook event: ${formatValidationErrors(errors)}`,
    );
  }
  return mapZaloEvent(dto);
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
