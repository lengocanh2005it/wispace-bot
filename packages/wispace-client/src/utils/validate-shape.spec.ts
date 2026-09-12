import { z } from 'zod';
import { ShapeValidationError, validateShape } from './validate-shape';

const schema = z.object({
  name: z.string().min(1),
  score: z.number(),
  note: z.string().optional(),
});

describe('validateShape (zod bridge, ADR 0010)', () => {
  it('returns the parsed value and tolerates extra fields', () => {
    const value = { name: 'a', score: 1, extra: 'kept? no, stripped' };
    const parsed = validateShape(schema, value);
    expect(parsed.name).toBe('a');
    expect(parsed.score).toBe(1);
  });

  it('throws root ShapeValidationError for non-object values', () => {
    expect(() => validateShape(schema, 42)).toThrow(ShapeValidationError);
    try {
      validateShape(schema, null);
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ShapeValidationError);
      expect((error as ShapeValidationError).field).toBe('(root)');
      expect((error as ShapeValidationError).message).toMatch(
        /Expected object, received/,
      );
    }
  });

  it('maps missing fields to the legacy "Missing required field" message', () => {
    expect(() => validateShape(schema, { score: 1 })).toThrow(
      'Missing required field "name"',
    );
    expect(() => validateShape(schema, { name: null, score: 1 })).toThrow(
      'Missing required field "name"',
    );
  });

  it('maps type violations to the legacy "Invalid field" message', () => {
    expect(() => validateShape(schema, { name: 5, score: 1 })).toThrow(
      /Invalid field "name"/,
    );
    expect(() =>
      validateShape(schema, { name: 'x', score: Number.NaN }),
    ).toThrow(/Invalid field "score"/);
  });

  it('exposes field/expected/received on the error', () => {
    try {
      validateShape(schema, { name: '', score: 1 });
      throw new Error('expected throw');
    } catch (error) {
      expect(error).toBeInstanceOf(ShapeValidationError);
      const shapeError = error as ShapeValidationError;
      expect(shapeError.name).toBe('ShapeValidationError');
      expect(shapeError.field).toBe('name');
      expect(shapeError.received).toBe('');
    }
  });
});
