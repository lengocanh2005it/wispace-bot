import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RecordWebActivityBody } from './web-activity.dto';

function errorsFor(body: unknown): string[] {
  const dto = plainToInstance(RecordWebActivityBody, body);
  return validateSync(dto).map((e) => e.property);
}

describe('RecordWebActivityBody', () => {
  it('accepts a positive integer userId with no activeAt', () => {
    expect(errorsFor({ userId: 42 })).toEqual([]);
  });

  it('accepts an ISO 8601 activeAt', () => {
    expect(errorsFor({ userId: 42, activeAt: '2026-08-29T10:00:00Z' })).toEqual(
      [],
    );
  });

  it('rejects a missing userId', () => {
    expect(errorsFor({})).toContain('userId');
  });

  it('rejects a non-positive userId', () => {
    expect(errorsFor({ userId: 0 })).toContain('userId');
    expect(errorsFor({ userId: -3 })).toContain('userId');
  });

  it('rejects a non-integer userId', () => {
    expect(errorsFor({ userId: 1.5 })).toContain('userId');
  });

  it('rejects a non-ISO activeAt', () => {
    expect(errorsFor({ userId: 1, activeAt: 'yesterday' })).toContain(
      'activeAt',
    );
  });
});
