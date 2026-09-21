import fc from 'fast-check';
import {
  normalizeUserCalendarRecord,
  normalizeUserCalendarRecords,
} from './user-calendar-record.normalizer';
import { ShapeValidationError } from '../utils/validate-shape';

fc.configureGlobal({ numRuns: 200 });

const EVENT_DATE = fc.constantFrom('2026-01-01', '2026-06-15', '2026-12-31');
const TIME = fc.constantFrom('00:00', '09:30', '23:59');
const VALID_RECORD = fc.record({
  id: fc.integer({ min: 1, max: 1_000_000 }),
  eventDate: EVENT_DATE,
  time: fc.option(TIME, { nil: null }),
  userId: fc.integer({ min: 0, max: 1_000_000 }),
  createdAt: fc.option(
    fc.constantFrom('2026-01-01T00:00:00.000Z', '2026-06-15T12:30:00.000Z'),
    { nil: undefined },
  ),
});

describe('user calendar normalizer properties', () => {
  it('is stable and treats PascalCase aliases as equivalent', () => {
    fc.assert(
      fc.property(VALID_RECORD, (raw) => {
        const normalized = normalizeUserCalendarRecord(raw);
        const pascalCase = {
          Id: raw.id,
          EventDate: raw.eventDate,
          Time: raw.time,
          UserId: raw.userId,
          CreatedAt: raw.createdAt,
        };

        expect(normalized).not.toBeNull();
        expect(normalizeUserCalendarRecord(normalized)).toEqual(normalized);
        expect(normalizeUserCalendarRecord(pascalCase)).toEqual(normalized);
      }),
    );
  });

  it('preserves the number of valid rows', () => {
    fc.assert(
      fc.property(fc.array(VALID_RECORD, { maxLength: 20 }), (rows) => {
        expect(normalizeUserCalendarRecords(rows)).toHaveLength(rows.length);
      }),
    );
  });

  it('fails closed instead of dropping an invalid row', () => {
    const invalidRow = fc.oneof(
      fc.constant({ eventDate: '2026-01-01' }),
      fc.record({ id: fc.integer({ max: 0 }), eventDate: EVENT_DATE }),
      fc.record({ id: fc.integer({ min: 1 }), eventDate: fc.constant('') }),
    );

    fc.assert(
      fc.property(invalidRow, (row) => {
        expect(() =>
          normalizeUserCalendarRecords([
            { id: 1, eventDate: '2026-01-01', time: '09:30' },
            row,
          ]),
        ).toThrow(ShapeValidationError);
      }),
    );
  });
});
