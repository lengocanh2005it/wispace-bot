import { parseCookieHeader } from './cookie-header';

describe('parseCookieHeader', () => {
  it('returns an empty map for missing headers', () => {
    expect(parseCookieHeader(undefined)).toEqual({});
    expect(parseCookieHeader(null)).toEqual({});
    expect(parseCookieHeader('')).toEqual({});
  });

  it('parses a single cookie pair', () => {
    expect(parseCookieHeader('zalo_oauth_state=abc123')).toEqual({
      zalo_oauth_state: 'abc123',
    });
  });

  it('parses multiple pairs and trims whitespace', () => {
    expect(parseCookieHeader('a=1; b = two ;c=3')).toEqual({
      a: '1',
      b: 'two',
      c: '3',
    });
  });

  it('decodes percent-encoded values', () => {
    expect(parseCookieHeader('state=%41%42%43')).toEqual({ state: 'ABC' });
  });

  it('keeps the raw value when percent-decoding fails', () => {
    expect(parseCookieHeader('state=%ZZ')).toEqual({ state: '%ZZ' });
  });

  it('preserves "=" characters inside values', () => {
    expect(parseCookieHeader('token=abc==;other=x')).toEqual({
      token: 'abc==',
      other: 'x',
    });
  });

  it('lets the first occurrence win on duplicate names', () => {
    expect(parseCookieHeader('state=first; state=second')).toEqual({
      state: 'first',
    });
  });

  it('skips malformed segments without "=" or empty names', () => {
    expect(parseCookieHeader('novalue; =empty; state=ok')).toEqual({
      state: 'ok',
    });
  });

  it('cannot pollute Object.prototype via cookie names', () => {
    parseCookieHeader('__proto__=polluted');
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});
