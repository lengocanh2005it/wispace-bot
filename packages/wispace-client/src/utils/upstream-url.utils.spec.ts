import { validateUpstreamUrl } from './upstream-url.utils';

const CONTEXT = 'WISPACE_API_TEST_URL';

describe('validateUpstreamUrl', () => {
  it('accepts a valid HTTPS URL', () => {
    expect(
      validateUpstreamUrl('https://backend.example.com/api/User/goals', {
        context: CONTEXT,
      }),
    ).toBe('https://backend.example.com/api/User/goals');
  });

  it.each(['not-a-url', 'ftp://example.com/x', '//example.com/x', ''])(
    'rejects an unparseable or non-HTTP(S) value: %s',
    (value) => {
      expect(() => validateUpstreamUrl(value, { context: CONTEXT })).toThrow(
        CONTEXT,
      );
    },
  );

  it('rejects HTTP outside the development/test loopback exception', () => {
    expect(() =>
      validateUpstreamUrl('http://backend.example.com/x', {
        context: CONTEXT,
      }),
    ).toThrow('must use HTTPS');

    expect(() =>
      validateUpstreamUrl('http://backend.example.com/x', {
        context: CONTEXT,
        nodeEnv: 'production',
      }),
    ).toThrow('must use HTTPS');
  });

  it('allows http://localhost only in an explicit development/test env', () => {
    expect(
      validateUpstreamUrl('http://localhost:8080/wispace', {
        context: CONTEXT,
        nodeEnv: 'development',
      }),
    ).toBe('http://localhost:8080/wispace');

    expect(
      validateUpstreamUrl('http://127.0.0.1:8080/wispace', {
        context: CONTEXT,
        nodeEnv: 'test',
      }),
    ).toBe('http://127.0.0.1:8080/wispace');

    expect(() =>
      validateUpstreamUrl('http://localhost:8080/wispace', {
        context: CONTEXT,
        nodeEnv: 'production',
      }),
    ).toThrow('must use HTTPS');
  });

  it('rejects URLs with embedded credentials', () => {
    expect(() =>
      validateUpstreamUrl('https://user:pass@backend.example.com/x', {
        context: CONTEXT,
      }),
    ).toThrow('must not contain credentials');
  });

  it('rejects URLs with a fragment', () => {
    expect(() =>
      validateUpstreamUrl('https://backend.example.com/x#section', {
        context: CONTEXT,
      }),
    ).toThrow('must not contain a fragment');
  });

  it.each([undefined, 'production'])(
    'rejects loopback/private targets outside development: NODE_ENV=%s',
    (nodeEnv) => {
      const env = nodeEnv ? { nodeEnv } : {};
      expect(() =>
        validateUpstreamUrl('https://localhost/api', {
          context: CONTEXT,
          ...env,
        }),
      ).toThrow('must not target localhost or a private network');
      expect(() =>
        validateUpstreamUrl('https://192.168.1.10/api', {
          context: CONTEXT,
          ...env,
        }),
      ).toThrow('must not target localhost or a private network');
    },
  );

  it('allows private targets in development', () => {
    expect(
      validateUpstreamUrl('https://192.168.1.10/api', {
        context: CONTEXT,
        nodeEnv: 'development',
      }),
    ).toBe('https://192.168.1.10/api');
  });

  it('rejects a host not in the allowlist', () => {
    expect(() =>
      validateUpstreamUrl('https://other.example.com/x', {
        context: CONTEXT,
        allowedHosts: ['backend.example.com'],
      }),
    ).toThrow('is not in WISPACE_ALLOWED_HOSTS');
  });

  it('accepts a host in the allowlist (case-insensitive)', () => {
    expect(
      validateUpstreamUrl('https://Backend.Example.com/x', {
        context: CONTEXT,
        allowedHosts: ['backend.example.com'],
      }),
    ).toBe('https://Backend.Example.com/x');
  });

  it('does not enforce the allowlist when it is empty', () => {
    expect(
      validateUpstreamUrl('https://backend.example.com/x', {
        context: CONTEXT,
        allowedHosts: [],
      }),
    ).toBe('https://backend.example.com/x');
  });
});
