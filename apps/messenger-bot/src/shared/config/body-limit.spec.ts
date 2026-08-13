import { parseJsonBodyLimit } from './body-limit';

describe('parseJsonBodyLimit', () => {
  it('parses supported byte units', () => {
    expect(parseJsonBodyLimit('256kb')).toBe(256 * 1024);
    expect(parseJsonBodyLimit('1mb')).toBe(1024 * 1024);
  });

  it('rejects invalid or oversized values', () => {
    expect(() => parseJsonBodyLimit('unlimited')).toThrow();
    expect(() => parseJsonBodyLimit('2mb')).toThrow();
  });
});
