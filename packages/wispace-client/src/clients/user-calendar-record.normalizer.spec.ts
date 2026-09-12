import {
  normalizeUserCalendarRecord,
  normalizeUserCalendarRecords,
} from './user-calendar-record.normalizer';
import { ShapeValidationError } from '../utils/validate-shape';

describe('user-calendar-record.normalizer', () => {
  it('normalizes a raw record with PascalCase fallback fields', () => {
    const record = normalizeUserCalendarRecord({
      Id: 42,
      EventDate: '2026-08-01T00:00:00Z',
      Time: '14:00',
      UserId: 143,
    });

    expect(record).toEqual({
      id: 42,
      userId: 143,
      eventDate: '2026-08-01',
      time: '14:00',
      createdAt: undefined,
    });
  });

  it('returns null for a record with no valid id', () => {
    expect(normalizeUserCalendarRecord({ eventDate: '2026-08-01' })).toBeNull();
  });

  it('normalizes an array payload wrapped in { data }', () => {
    const records = normalizeUserCalendarRecords({
      data: [{ id: 1, eventDate: '2026-08-01', time: '10:00' }],
    });

    expect(records).toHaveLength(1);
    expect(records[0].id).toBe(1);
  });

  it('throws for an unrecognized payload shape (fail closed, #656)', () => {
    expect(() => normalizeUserCalendarRecords({ foo: 'bar' })).toThrow(
      ShapeValidationError,
    );
  });

  it('throws for a garbage row instead of silently dropping it (#656)', () => {
    expect(() =>
      normalizeUserCalendarRecords([
        { id: 1, eventDate: '2026-08-01', time: '10:00' },
        { eventDate: '2026-08-02' },
      ]),
    ).toThrow(/index 1/);
  });
});
