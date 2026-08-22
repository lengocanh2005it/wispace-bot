import {
  validateShape,
  ShapeValidationError,
  isNonEmptyString,
  isPositiveNumber,
  isDateString,
  isHttpsUrl,
} from './validate-shape';

describe('validateShape', () => {
  it('returns typed value when valid', () => {
    const result = validateShape<{ name: string; age: number }>(
      { name: 'test', age: 25 },
      [
        { name: 'name', validate: isNonEmptyString, expected: 'string' },
        { name: 'age', validate: isPositiveNumber, expected: 'number' },
      ],
    );
    expect(result).toEqual({ name: 'test', age: 25 });
  });

  it('throws ShapeValidationError for non-object', () => {
    expect(() => validateShape('not-object', [])).toThrow(ShapeValidationError);
    expect(() => validateShape(null, [])).toThrow(ShapeValidationError);
    expect(() => validateShape(42, [])).toThrow(ShapeValidationError);
  });

  it('throws for missing required field', () => {
    expect(() =>
      validateShape({ name: 'test' }, [
        { name: 'name', validate: isNonEmptyString, expected: 'string' },
        { name: 'age', validate: isPositiveNumber, expected: 'number' },
      ]),
    ).toThrow('Missing required field "age"');
  });

  it('allows optional fields', () => {
    const result = validateShape<{ name: string; age?: number }>(
      { name: 'test' },
      [
        { name: 'name', validate: isNonEmptyString, expected: 'string' },
        {
          name: 'age',
          validate: isPositiveNumber,
          expected: 'number',
          required: false,
        },
      ],
    );
    expect(result).toEqual({ name: 'test' });
  });

  it('throws for invalid field value', () => {
    expect(() =>
      validateShape({ name: '', age: 25 }, [
        {
          name: 'name',
          validate: isNonEmptyString,
          expected: 'non-empty string',
        },
        { name: 'age', validate: isPositiveNumber, expected: 'number' },
      ]),
    ).toThrow('Invalid field "name"');
  });

  it('includes field info in error', () => {
    try {
      validateShape({ name: 123 }, [
        { name: 'name', validate: isNonEmptyString, expected: 'string' },
      ]);
      fail('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ShapeValidationError);
      expect((error as ShapeValidationError).field).toBe('name');
      expect((error as ShapeValidationError).expected).toBe('string');
    }
  });
});

describe('validation helpers', () => {
  describe('isNonEmptyString', () => {
    it.each(['hello', 'a', ' '])('accepts "%s"', (v) => {
      expect(isNonEmptyString(v)).toBe(true);
    });

    it.each(['', undefined, null, 123])('rejects %s', (v) => {
      expect(isNonEmptyString(v)).toBe(false);
    });
  });

  describe('isPositiveNumber', () => {
    it.each([1, 0.5, 100, Number.MAX_SAFE_INTEGER])('accepts %s', (v) => {
      expect(isPositiveNumber(v)).toBe(true);
    });

    it.each([0, -1, NaN, Infinity, undefined, null, '123'])(
      'rejects %s',
      (v) => {
        expect(isPositiveNumber(v)).toBe(false);
      },
    );
  });

  describe('isDateString', () => {
    it.each([
      '2026-09-01',
      '2026-01-01T00:00:00Z',
      '2026-06-15T12:30:00+07:00',
    ])('accepts "%s"', (v) => {
      expect(isDateString(v)).toBe(true);
    });

    it.each(['not-a-date', '2026-13-01', '', undefined, null, 123])(
      'rejects "%s"',
      (v) => {
        expect(isDateString(v)).toBe(false);
      },
    );
  });

  describe('isHttpsUrl', () => {
    it.each([
      'https://example.com',
      'https://api.wispace.io/goals',
      'https://sub.domain.com:8080/path',
    ])('accepts "%s"', (v) => {
      expect(isHttpsUrl(v)).toBe(true);
    });

    it.each([
      'http://example.com',
      'ftp://example.com',
      'not-a-url',
      '',
      undefined,
      null,
      123,
    ])('rejects "%s"', (v) => {
      expect(isHttpsUrl(v)).toBe(false);
    });
  });
});
