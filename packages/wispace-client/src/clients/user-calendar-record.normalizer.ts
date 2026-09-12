import { z } from 'zod';
import type { UserCalendarRecord } from '../types/user-calendar.types';
import { ShapeValidationError, validateShape } from '../utils/validate-shape';

/**
 * Contract of the normalized record emitted to business logic (ADR 0010).
 * The normalizer below is the lenient layer (PascalCase, Date objects, null
 * time); this schema is the last fence before the record is consumed — a
 * normalized row that cannot satisfy it is a contract drift, not a drop.
 */
const userCalendarRecordSchema = z.object({
  id: z.number().positive().finite(),
  userId: z.number().finite(),
  eventDate: z.string().min(1),
  time: z.string().nullable(),
  createdAt: z.string().optional(),
});

function stringifyCalendarField(value: unknown): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean'
  ) {
    return String(value).trim();
  }

  return '';
}

export function unwrapCalendarCreatePayload(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object') {
    return payload;
  }

  const obj = payload as Record<string, unknown>;
  const data = obj.data ?? obj.Data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    return data;
  }

  return payload;
}

export function normalizeCreatedCalendarRecord(
  payload: unknown,
  input: { eventDate: string; time: string; userId?: number },
): UserCalendarRecord | null {
  const normalized = normalizeUserCalendarRecord(
    unwrapCalendarCreatePayload(payload),
  );
  if (normalized) {
    return validateShape(userCalendarRecordSchema, normalized);
  }

  const raw = unwrapCalendarCreatePayload(payload);
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const item = raw as Record<string, unknown>;
  const id = Number(item.id ?? item.Id);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }

  let eventDate = input.eventDate.trim();
  if (/^\d{4}-\d{2}-\d{2}T/.test(eventDate)) {
    eventDate = eventDate.slice(0, 10);
  }

  const userId = Number(item.userId ?? item.UserId ?? input.userId ?? 0);

  return validateShape(userCalendarRecordSchema, {
    id,
    userId: Number.isFinite(userId) ? userId : 0,
    eventDate,
    time: input.time,
  });
}

export function normalizeUserCalendarRecord(
  raw: unknown,
): UserCalendarRecord | null {
  if (!raw || typeof raw !== 'object') {
    return null;
  }

  const item = raw as Record<string, unknown>;
  const id = Number(item.id ?? item.Id);
  if (!Number.isFinite(id) || id <= 0) {
    return null;
  }

  const eventDateRaw = item.eventDate ?? item.EventDate;
  if (eventDateRaw === undefined || eventDateRaw === null) {
    return null;
  }

  let eventDate = stringifyCalendarField(eventDateRaw);
  if (!eventDate) {
    return null;
  }

  if (/^\d{4}-\d{2}-\d{2}T/.test(eventDate)) {
    eventDate = eventDate.slice(0, 10);
  }

  const timeRaw = item.time ?? item.Time;
  const timeValue = stringifyCalendarField(timeRaw);
  const time =
    timeRaw === null || timeRaw === undefined ? null : timeValue || null;

  const userId = Number(item.userId ?? item.UserId ?? 0);
  const createdAtRaw = item.createdAt ?? item.CreatedAt;
  const createdAtValue = stringifyCalendarField(createdAtRaw);

  return {
    id,
    userId: Number.isFinite(userId) ? userId : 0,
    eventDate,
    time,
    createdAt:
      createdAtRaw === undefined || createdAtRaw === null
        ? undefined
        : createdAtValue || undefined,
  };
}

export function normalizeUserCalendarRecords(
  payload: unknown,
): UserCalendarRecord[] {
  const rows = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as { data?: unknown }).data)
      ? (payload as { data: unknown[] }).data
      : null;

  if (!rows) {
    throw new ShapeValidationError(
      `Expected array, received ${payload === null ? 'null' : typeof payload}`,
      '(root)',
      'array',
      payload,
    );
  }

  return rows.map((row, index) => {
    const record = normalizeUserCalendarRecord(row);
    if (!record) {
      throw new ShapeValidationError(
        `Invalid calendar record at index ${index}`,
        String(index),
        'UserCalendarRecord',
        row,
      );
    }
    return validateShape(userCalendarRecordSchema, record);
  });
}
