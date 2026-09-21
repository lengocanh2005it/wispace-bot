import fc from 'fast-check';
import { parseCookieHeader } from './cookie-header';

fc.configureGlobal({ numRuns: 200 });

const COOKIE_CHAR = fc.constantFrom(
  ...'abcdefghijklmnopqrstuvwxyz0123456789_'.split(''),
);
const COOKIE_NAME = fc
  .array(COOKIE_CHAR, { minLength: 1, maxLength: 12 })
  .map((chars) => chars.join(''));
const COOKIE_VALUE = fc
  .array(
    fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789%='.split('')),
    {
      maxLength: 20,
    },
  )
  .map((chars) => chars.join(''));
const COOKIE_PAIRS = fc.array(fc.tuple(COOKIE_NAME, COOKIE_VALUE), {
  minLength: 1,
  maxLength: 12,
});

function renderCookieHeader(pairs: Array<[string, string]>): string {
  return pairs.map(([name, value]) => `${name}=${value}`).join('; ');
}

function uniqueNamesInOrder(pairs: Array<[string, string]>): string[] {
  const seen = new Set<string>();
  return pairs.flatMap(([name]) => {
    if (seen.has(name)) return [];
    seen.add(name);
    return [name];
  });
}

function expectedCookieValue(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

describe('cookie header properties', () => {
  it('parses generated pairs with first-duplicate-wins semantics', () => {
    fc.assert(
      fc.property(COOKIE_PAIRS, (pairs) => {
        const result = parseCookieHeader(renderCookieHeader(pairs));

        expect(Object.getPrototypeOf(result)).toBeNull();
        expect(Object.keys(result).sort()).toEqual(
          uniqueNamesInOrder(pairs).sort(),
        );
        for (const [name, value] of pairs) {
          expect(result[name]).toBe(
            expectedCookieValue(
              pairs.find(([candidate]) => candidate === name)?.[1] ?? value,
            ),
          );
        }
      }),
    );
  });

  it('never throws for arbitrary non-empty header text', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), (header) => {
        expect(() => parseCookieHeader(header)).not.toThrow();
        expect(Object.getPrototypeOf(parseCookieHeader(header))).toBeNull();
      }),
    );
  });

  it('keeps malformed percent escapes raw', () => {
    fc.assert(
      fc.property(fc.constantFrom('%', '%A', '%ZZ', '%0G'), (value) => {
        expect(parseCookieHeader(`state=${value}`).state).toBe(value);
      }),
    );
  });

  it('keeps attacker-controlled prototype names as inert own data', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('__proto__', 'constructor', 'prototype'),
        fc.string({ maxLength: 30 }),
        (name, value) => {
          const result = parseCookieHeader(`${name}=${value}`);
          expect(Object.prototype.hasOwnProperty.call(result, name)).toBe(true);
          expect(({} as Record<string, unknown>).polluted).toBeUndefined();
        },
      ),
    );
  });
});
