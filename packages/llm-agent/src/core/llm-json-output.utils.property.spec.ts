import fc from 'fast-check';
import { parseJsonObject, readRequiredStringField } from './index';

const ARBITRARY_STRING: fc.Arbitrary<string> = fc.oneof(
  fc
    .string({ maxLength: 2048 })
    .chain((value) =>
      fc.constantFrom(value, `${value}{`, `{${value}`, `${value}}`),
    ),
  fc.jsonValue().map((value) => JSON.stringify(value)),
  fc.constantFrom('[]', '[1,2,3]', 'null', 'true', '42', '"text"', '{}'),
);

type ClassifiedOutcome<T> =
  | { kind: 'result'; value: T }
  | { kind: 'error'; error: unknown };

function classifyOutcome<T>(fn: () => T): ClassifiedOutcome<T> {
  try {
    return { kind: 'result', value: fn() };
  } catch (error) {
    return { kind: 'error', error };
  }
}

fc.configureGlobal({ numRuns: 200 });

describe('llm-json-output core API', () => {
  it('rejects non-object JSON and accepts JSON objects', () => {
    expect(() => parseJsonObject('[]')).toThrow(
      'LLM JSON output must be an object',
    );
    expect(() => parseJsonObject('null')).toThrow(
      'LLM JSON output must be an object',
    );
    expect(parseJsonObject('{"headline":"ok"}')).toEqual({
      headline: 'ok',
    });
  });

  it('parses arbitrary input to an object or a bounded error', () => {
    fc.assert(
      fc.property(ARBITRARY_STRING, (content) => {
        const outcome = classifyOutcome(() => parseJsonObject(content));
        if (outcome.kind === 'result') {
          expect(outcome.value).not.toBeNull();
          expect(Array.isArray(outcome.value)).toBe(false);
        } else {
          expect(outcome.error).toBeInstanceOf(Error);
          expect((outcome.error as Error).message.length).toBeLessThan(1000);
        }
      }),
    );
  });

  it('normalizes required strings and applies the optional sanitizer before the length cap', () => {
    expect(
      readRequiredStringField(
        { headline: '  **A\n  useful   headline**  ' },
        'headline',
        {
          sanitize: (raw) => raw.replace(/\*\*/g, ''),
          maxChars: 8,
        },
      ),
    ).toBe('A useful...');
  });

  it('rejects missing, non-string, and whitespace-only fields', () => {
    expect(() => readRequiredStringField({}, 'headline')).toThrow(
      'LLM JSON output missing string field: headline',
    );
    expect(() => readRequiredStringField({ headline: 7 }, 'headline')).toThrow(
      'LLM JSON output missing string field: headline',
    );
    expect(() =>
      readRequiredStringField({ headline: ' \n ' }, 'headline'),
    ).toThrow('LLM JSON output has empty string field: headline');
  });

  it('caps arbitrary non-empty strings after whitespace normalization', () => {
    fc.assert(
      fc.property(fc.jsonValue(), (rawValue) => {
        const outcome = classifyOutcome(() =>
          readRequiredStringField({ headline: rawValue }, 'headline'),
        );
        if (outcome.kind === 'result') {
          expect(outcome.value.length).toBeLessThanOrEqual(603);
          expect(outcome.value.trim().length).toBeGreaterThan(0);
        } else {
          expect((outcome.error as Error).message).toContain('headline');
        }
      }),
    );
  });

  it('keeps prototype-pollution keys as inert own data', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('__proto__', 'constructor', 'prototype'),
        fc.string({ maxLength: 100 }),
        (key, value) => {
          const parsed = parseJsonObject(
            JSON.stringify({ [key]: value, headline: 'Real headline' }),
          );
          expect(parsed.headline).toBe('Real headline');
          expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
        },
      ),
    );
  });
});
